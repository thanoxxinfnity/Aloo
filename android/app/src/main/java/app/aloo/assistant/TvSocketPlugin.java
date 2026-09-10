package app.aloo.assistant;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * A WebSocket that lives in native code instead of in the page.
 *
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * The LG TV's control protocol (SSAP) is a plain, unencrypted WebSocket on port
 * 3000. The TV has no certificate and offers no wss:// — that is simply how
 * webOS ships, and there is nothing to configure on the TV to change it.
 *
 * Capacitor serves the app from `https://localhost`. Chromium then applies its
 * mixed-content rule and refuses outright to construct a `ws://` socket from an
 * `https://` document:
 *
 *     Failed to construct 'WebSocket': An insecure WebSocket connection may not
 *     be initiated from a page loaded over HTTPS.
 *
 * Three things that look like fixes and are not:
 *
 *   • `usesCleartextTraffic="true"` — governs Android's NETWORK STACK. The
 *     block above happens earlier, inside Blink, before any socket is opened.
 *     It has no effect here.
 *
 *   • `androidScheme: 'http'` — would work, but it changes the WebView's ORIGIN,
 *     and origin is what localStorage is keyed on. Every stored API key, every
 *     setting and the TV's own pairing key would vanish on update. Too high a
 *     price for one socket.
 *
 *   • A local wss:// proxy with a self-signed certificate — the WebView rejects
 *     the certificate, so it trades one block for another.
 *
 * Moving the socket into Java sidesteps the rule rather than fighting it: the
 * page keeps its https origin and all its stored data, and the bytes are sent
 * by OkHttp, which answers to Android's network policy (cleartext allowed) and
 * not to Blink's page policy.
 *
 * SHAPE OF THE BRIDGE
 * Sockets are addressed by a caller-supplied id, because the TV needs two at
 * once: the JSON command socket, and the separate line-based "pointer" socket
 * it hands out for arrow keys. Everything the socket does is reported as an
 * event (`tvSocketMessage`, `tvSocketClosed`, `tvSocketError`) carrying that
 * id, so the JavaScript side can present a familiar WebSocket-like object.
 */
@CapacitorPlugin(name = "TvSocket")
public class TvSocketPlugin extends Plugin {

    /** Live sockets, keyed by the id JavaScript gave us. */
    private final Map<String, WebSocket> sockets = new ConcurrentHashMap<>();

    /**
     * One client for every socket.
     *
     * readTimeout(0) matters: OkHttp's default read timeout would tear down an
     * idle control socket after ten seconds, and a TV that nobody is talking to
     * is idle almost all the time. Liveness is kept by pings instead, which also
     * means a TV that is unplugged mid-session is noticed within ~30s rather
     * than hanging forever.
     *
     * connectTimeout is deliberately short. The overwhelmingly common failure is
     * a wrong IP or a TV on another network, and waiting the default ten seconds
     * to say so just feels broken.
     */
    private final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .build();

    /**
     * A second client, built lazily, for the `wss://…:3001` port that webOS 6
     * and later expose instead of plain 3000.
     *
     * That port presents a SELF-SIGNED certificate issued to the TV itself.
     * There is no certificate authority anywhere in the chain and no way to add
     * one — LG ships it that way and the TV has no setting for it — so ordinary
     * validation can only ever fail, and a TV that offers nothing else would be
     * uncontrollable.
     *
     * The scope of the exception is deliberately tiny, and worth being precise
     * about because "trust every certificate" is normally a serious mistake:
     *
     *   • It applies to this client only. Every other request the app makes —
     *     each model provider, search, everything — goes through the default
     *     client (or Capacitor's own HTTP), which validates normally. Nothing
     *     here loosens those.
     *   • It is reached only for an address the user typed themselves, for a
     *     device on their own LAN, and only after plain ws:// was refused.
     *   • The only secret that crosses it is the TV's own pairing key, which is
     *     worth exactly one thing: controlling that television.
     */
    private volatile OkHttpClient insecureClient;

    private OkHttpClient insecureClient() {
        OkHttpClient existing = insecureClient;
        if (existing != null) return existing;
        synchronized (this) {
            if (insecureClient != null) return insecureClient;
            try {
                X509TrustManager permissive = new X509TrustManager() {
                    @Override
                    public void checkClientTrusted(X509Certificate[] chain, String authType) { }

                    @Override
                    public void checkServerTrusted(X509Certificate[] chain, String authType) { }

                    @Override
                    public X509Certificate[] getAcceptedIssuers() {
                        return new X509Certificate[0];
                    }
                };
                SSLContext ctx = SSLContext.getInstance("TLS");
                ctx.init(null, new TrustManager[] { permissive }, new SecureRandom());
                insecureClient = client.newBuilder()
                    .sslSocketFactory(ctx.getSocketFactory(), permissive)
                    // The certificate's subject is the TV's own name, never the
                    // IP address it is reached by, so the hostname check would
                    // fail even if the certificate itself were trusted.
                    .hostnameVerifier((hostname, session) -> true)
                    .build();
            } catch (Exception err) {
                // Falling back to the strict client keeps the failure honest: the
                // connection will be refused rather than silently downgraded.
                insecureClient = client;
            }
            return insecureClient;
        }
    }

    /** Availability probe, so JavaScript can pick native vs. browser socket. */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", true);
        call.resolve(ret);
    }

    /**
     * Open a socket. Resolves once the server has accepted the upgrade, rejects
     * if the connection fails before that. Anything after the handshake arrives
     * as an event, never as a resolution of this call.
     */
    @PluginMethod
    public void open(PluginCall call) {
        final String id = call.getString("id");
        final String url = call.getString("url");
        if (id == null || id.isEmpty()) {
            call.reject("A socket id is required");
            return;
        }
        if (url == null || url.isEmpty()) {
            call.reject("A socket url is required");
            return;
        }

        // Re-opening the same id closes whatever was there, so a retry after a
        // failed pairing cannot leave a stale socket receiving messages.
        closeSocket(id, 1000, "reopened");

        final Request request;
        try {
            // OkHttp accepts ws:// and wss:// here and maps them onto http/https
            // internally; passing the scheme through unchanged keeps the caller
            // honest about which one it asked for.
            request = new Request.Builder().url(url).build();
        } catch (IllegalArgumentException err) {
            call.reject("That does not look like a WebSocket address: " + url);
            return;
        }

        // The listener fires on OkHttp's own thread and may fire more than once;
        // the call may only be settled once, hence the guard.
        final AtomicBoolean settled = new AtomicBoolean(false);

        // Only the TV's certificate-less wss:// port asks for this, and only
        // after plain ws:// has already been refused. See insecureClient().
        final boolean insecure = Boolean.TRUE.equals(call.getBoolean("insecure", false));
        final OkHttpClient using = insecure ? insecureClient() : client;

        WebSocket ws = using.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(@NonNull WebSocket webSocket, @NonNull Response response) {
                sockets.put(id, webSocket);
                if (settled.compareAndSet(false, true)) {
                    JSObject ret = new JSObject();
                    ret.put("id", id);
                    call.resolve(ret);
                }
            }

            @Override
            public void onMessage(@NonNull WebSocket webSocket, @NonNull String text) {
                JSObject ev = new JSObject();
                ev.put("id", id);
                ev.put("data", text);
                emit("tvSocketMessage", ev);
            }

            @Override
            public void onMessage(@NonNull WebSocket webSocket, @NonNull ByteString bytes) {
                // webOS is text-only, but a binary frame must not be dropped
                // silently: decoding as UTF-8 keeps the JSON path working if a
                // future firmware ever sends one.
                JSObject ev = new JSObject();
                ev.put("id", id);
                ev.put("data", bytes.utf8());
                emit("tvSocketMessage", ev);
            }

            @Override
            public void onClosing(@NonNull WebSocket webSocket, int code, @NonNull String reason) {
                // Acknowledge so the peer can finish its half of the close.
                webSocket.close(code, null);
            }

            @Override
            public void onClosed(@NonNull WebSocket webSocket, int code, @NonNull String reason) {
                sockets.remove(id, webSocket);
                JSObject ev = new JSObject();
                ev.put("id", id);
                ev.put("code", code);
                ev.put("reason", reason);
                emit("tvSocketClosed", ev);
                if (settled.compareAndSet(false, true)) {
                    call.reject("The TV closed the connection before it was established (" + code + ")");
                }
            }

            @Override
            public void onFailure(
                @NonNull WebSocket webSocket,
                @NonNull Throwable t,
                @Nullable Response response
            ) {
                sockets.remove(id, webSocket);
                String message = describe(t, response);

                JSObject ev = new JSObject();
                ev.put("id", id);
                ev.put("message", message);
                emit("tvSocketError", ev);

                // A failure is also a close as far as the page is concerned —
                // OkHttp does not deliver onClosed after onFailure, and without
                // this the JavaScript side would keep a dead socket "open".
                JSObject closed = new JSObject();
                closed.put("id", id);
                closed.put("code", 1006);
                closed.put("reason", message);
                emit("tvSocketClosed", closed);

                if (settled.compareAndSet(false, true)) {
                    call.reject(message);
                }
            }
        });

        // Registered eagerly as well as in onOpen: a close() arriving during the
        // handshake must still find something to cancel.
        sockets.putIfAbsent(id, ws);
    }

    @PluginMethod
    public void send(PluginCall call) {
        String id = call.getString("id");
        String data = call.getString("data");
        if (id == null || data == null) {
            call.reject("Both id and data are required");
            return;
        }
        WebSocket ws = sockets.get(id);
        if (ws == null) {
            call.reject("That socket is not open");
            return;
        }
        // False means the frame did not even make it into the outgoing queue —
        // the socket is closing or the buffer is full. Reporting it lets the
        // caller surface a real failure instead of waiting on a reply that will
        // never come.
        if (!ws.send(data)) {
            call.reject("The message could not be queued — the connection is closing");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        String id = call.getString("id");
        if (id == null) {
            call.reject("A socket id is required");
            return;
        }
        closeSocket(id, 1000, "closed by app");
        call.resolve();
    }

    /** Are we holding an open socket under this id? */
    @PluginMethod
    public void isOpen(PluginCall call) {
        String id = call.getString("id");
        JSObject ret = new JSObject();
        ret.put("open", id != null && sockets.containsKey(id));
        call.resolve(ret);
    }

    private void closeSocket(String id, int code, String reason) {
        WebSocket ws = sockets.remove(id);
        if (ws == null) return;
        // close() is the graceful path but is a no-op on a socket still in its
        // handshake, so cancel() follows to guarantee the connection ends.
        if (!ws.close(code, reason)) ws.cancel();
    }

    /**
     * Events are emitted on the WebView thread. Capacitor tolerates being called
     * from elsewhere, but listener callbacks run on OkHttp's dispatcher, and
     * hopping to the main thread keeps the ordering the page observes identical
     * to the order the frames arrived in.
     */
    private void emit(String name, JSObject data) {
        if (getBridge() == null) return;
        getBridge().executeOnMainThread(() -> notifyListeners(name, data));
    }

    /**
     * Turn a Java exception into something a person can act on. The raw text is
     * kept on the end because "connection refused" and "no route to host" mean
     * genuinely different things when hunting a TV on a network.
     */
    private static String describe(Throwable t, @Nullable Response response) {
        if (response != null && response.code() != 101) {
            return "The device at that address answered with HTTP " + response.code()
                + " instead of accepting a WebSocket. It may not be an LG webOS TV.";
        }
        String raw = t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
        String lower = raw.toLowerCase();
        if (lower.contains("econnrefused") || lower.contains("connection refused")) {
            return "The TV refused the connection on port 3000. Turn the TV on, and check "
                + "Settings → Network that 'LG Connect Apps' / Mobile TV On is enabled. (" + raw + ")";
        }
        if (lower.contains("ehostunreach") || lower.contains("no route to host")
            || lower.contains("enetunreach")) {
            return "That address is not reachable from this phone. The TV and the phone must be "
                + "on the same Wi-Fi network. (" + raw + ")";
        }
        if (lower.contains("timeout") || lower.contains("timed out")) {
            return "The TV did not answer in time. Check the IP address is still the one shown in "
                + "the TV's network settings — it changes when the TV reconnects. (" + raw + ")";
        }
        if (lower.contains("cleartext")) {
            return "Android blocked the plain connection to the TV. (" + raw + ")";
        }
        return raw;
    }

    /**
     * The WebView is gone; so is any reason to hold sockets open. Without this,
     * a backgrounded-then-killed app leaves the TV holding a registration that
     * blocks the next pairing attempt until it times out.
     */
    @Override
    protected void handleOnDestroy() {
        for (String id : sockets.keySet()) closeSocket(id, 1000, "app closed");
        super.handleOnDestroy();
    }
}
