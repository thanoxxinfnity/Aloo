package app.aloo.assistant;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.text.TextUtils;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The two things a television needs that are not a WebSocket, and that a
 * WebView therefore cannot do at all: UDP out.
 *
 * WAKE-ON-LAN — the reason "power on" was impossible before
 * ---------------------------------------------------------------------------
 * A TV that is off has no WebSocket server running, so there is nothing to
 * connect to and no command that could reach it. The only thing that wakes an
 * LG is a "magic packet": a UDP broadcast containing six 0xFF bytes followed by
 * the TV's MAC address repeated sixteen times, which the network card watches
 * for while the rest of the set is asleep.
 *
 * A browser has no UDP of any kind — no API, no workaround — which is why this
 * had to be reported as impossible while everything lived in the page. From
 * native code it is a dozen lines.
 *
 * The TV must have "Quick Start+" (older sets: "LG Connect Apps" / "Mobile TV
 * On") enabled, or its network card is powered down with everything else and no
 * packet can reach it. That is a setting on the TV; nothing here can substitute
 * for it.
 *
 * DISCOVERY — so nobody has to read an IP address off a settings screen
 * ---------------------------------------------------------------------------
 * `discover` sends an SSDP M-SEARCH to the standard multicast group and listens
 * for whatever answers. It asks for webOS specifically and for root devices
 * generally, because older sets answer only the latter.
 *
 * An IP address found this way is not permanent — a TV takes a new one from
 * DHCP whenever it reconnects, which is the most common reason a remote that
 * "worked yesterday" stops. Re-running discovery is the fix, and it is why this
 * exists as a button rather than a one-time setup step.
 */
@CapacitorPlugin(name = "TvNet")
public class TvNetPlugin extends Plugin {

    private static final String SSDP_ADDRESS = "239.255.255.250";
    private static final int SSDP_PORT = 1900;

    /**
     * webOS answers the first; anything DLNA-ish answers the second. Asking for
     * both and filtering afterwards finds more TVs than trusting either alone,
     * because LG changed the advertised service type across firmware years.
     */
    private static final String[] SEARCH_TARGETS = {
        "urn:lge-com:service:webos-second-screen:1",
        "urn:schemas-upnp-org:device:MediaRenderer:1",
        "ssdp:all",
    };

    /* ---------------------------------------------------------------- WOL -- */

    /**
     * Wake a TV by MAC address.
     *
     * The packet goes to several places on purpose. A directed broadcast to the
     * phone's own subnet (192.168.1.255, say) is what actually reaches a TV on
     * most home routers; 255.255.255.255 is the fallback for networks that
     * route the first oddly. Ports 9 and 7 are both conventional and TVs differ in
     * which they listen on, so both are used — the packets are 102 bytes and
     * cost nothing.
     */
    @PluginMethod
    public void wake(final PluginCall call) {
        // Explicitly off the caller's thread: Android kills any process that
        // touches a socket on the main thread, and a plugin call's thread is not
        // something this class should have to assume.
        new Thread(() -> wakeNow(call), "aloo-wol").start();
    }

    private void wakeNow(PluginCall call) {
        String mac = call.getString("mac");
        if (TextUtils.isEmpty(mac)) {
            call.reject("The TV's MAC address is needed to wake it.");
            return;
        }

        byte[] hardware;
        try {
            hardware = parseMac(mac);
        } catch (IllegalArgumentException err) {
            call.reject(err.getMessage());
            return;
        }

        // 6 x 0xFF, then the MAC sixteen times. This exact shape is what the
        // network card is watching for; anything else is ignored.
        byte[] packet = new byte[6 + 16 * 6];
        for (int i = 0; i < 6; i++) packet[i] = (byte) 0xFF;
        for (int i = 6; i < packet.length; i += 6) {
            System.arraycopy(hardware, 0, packet, i, 6);
        }

        List<InetAddress> targets = broadcastAddresses();
        int sent = 0;
        String lastError = null;

        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setBroadcast(true);
            for (InetAddress target : targets) {
                for (int port : new int[] { 9, 7 }) {
                    try {
                        socket.send(new DatagramPacket(packet, packet.length, target, port));
                        sent++;
                    } catch (Exception err) {
                        lastError = err.getMessage();
                    }
                }
            }
        } catch (Exception err) {
            call.reject("Could not open a socket to wake the TV: " + err.getMessage());
            return;
        }

        if (sent == 0) {
            call.reject("The wake packet could not be sent" + (lastError == null ? "." : ": " + lastError));
            return;
        }

        JSObject ret = new JSObject();
        ret.put("sent", sent);
        // Deliberately not "the TV is on": nothing acknowledges a magic packet,
        // so the only honest report is that it went out. The caller confirms by
        // trying to connect.
        ret.put("addresses", TextUtils.join(", ", describe(targets)));
        call.resolve(ret);
    }

    /** Accepts aa:bb:cc:dd:ee:ff, aa-bb-…, or bare hex. */
    private static byte[] parseMac(String raw) {
        String hex = raw.replaceAll("[^0-9a-fA-F]", "");
        if (hex.length() != 12) {
            throw new IllegalArgumentException(
                "\"" + raw + "\" is not a MAC address — it should be six pairs like 34:2f:bd:11:22:33."
            );
        }
        byte[] out = new byte[6];
        for (int i = 0; i < 6; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    /**
     * Every broadcast address this phone can see, plus the global one.
     *
     * Reading them off the interfaces rather than assuming /24 matters on
     * networks that are not — a phone tethering to a TV, for one, which is
     * exactly the arrangement this user has.
     */
    private static List<InetAddress> broadcastAddresses() {
        List<InetAddress> out = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> nics = NetworkInterface.getNetworkInterfaces();
            while (nics != null && nics.hasMoreElements()) {
                NetworkInterface nic = nics.nextElement();
                if (nic.isLoopback() || !nic.isUp()) continue;
                for (InterfaceAddress addr : nic.getInterfaceAddresses()) {
                    InetAddress broadcast = addr.getBroadcast();
                    if (broadcast != null && !out.contains(broadcast)) out.add(broadcast);
                }
            }
        } catch (Exception ignored) {
            // Falling through to the global broadcast below is better than
            // failing outright — it works on most home routers.
        }
        try {
            InetAddress global = InetAddress.getByName("255.255.255.255");
            if (!out.contains(global)) out.add(global);
        } catch (Exception ignored) { }
        return out;
    }

    private static List<String> describe(List<InetAddress> addresses) {
        List<String> out = new ArrayList<>();
        for (InetAddress a : addresses) out.add(a.getHostAddress());
        return out;
    }

    /* ---------------------------------------------------------- discovery -- */

    /**
     * Find TVs on this network.
     *
     * @return `devices`: [{ address, name, target }] — deduplicated by address.
     */
    @PluginMethod
    public void discover(final PluginCall call) {
        new Thread(() -> discoverNow(call), "aloo-ssdp").start();
    }

    private void discoverNow(final PluginCall call) {
        final int timeoutMs = Math.max(1200, Math.min(10000,
            call.getInt("timeoutMs", 4000)));

        // Android drops multicast on the Wi-Fi chip to save power unless
        // something asks it not to. Without this lock, M-SEARCH goes out and no
        // reply ever comes back — a silent, confusing failure.
        WifiManager wifi = (WifiManager) getContext()
            .getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        WifiManager.MulticastLock lock = null;
        if (wifi != null) {
            try {
                lock = wifi.createMulticastLock("aloo-ssdp");
                lock.setReferenceCounted(true);
                lock.acquire();
            } catch (Exception ignored) { }
        }

        // address -> friendly name, keeping insertion order so the first (and
        // usually most specific) answer wins.
        final Map<String, String> found = new LinkedHashMap<>();
        String error = null;

        try (MulticastSocket socket = new MulticastSocket()) {
            socket.setSoTimeout(400);
            socket.setReuseAddress(true);
            InetAddress group = InetAddress.getByName(SSDP_ADDRESS);

            for (String target : SEARCH_TARGETS) {
                String probe =
                    "M-SEARCH * HTTP/1.1\r\n"
                    + "HOST: " + SSDP_ADDRESS + ":" + SSDP_PORT + "\r\n"
                    + "MAN: \"ssdp:discover\"\r\n"
                    + "MX: 2\r\n"
                    + "ST: " + target + "\r\n\r\n";
                byte[] bytes = probe.getBytes(StandardCharsets.UTF_8);
                try {
                    socket.send(new DatagramPacket(
                        bytes, bytes.length, new InetSocketAddress(group, SSDP_PORT)));
                } catch (Exception ignored) { }
            }

            long deadline = System.currentTimeMillis() + timeoutMs;
            byte[] buffer = new byte[2048];
            while (System.currentTimeMillis() < deadline) {
                DatagramPacket reply = new DatagramPacket(buffer, buffer.length);
                try {
                    socket.receive(reply);
                } catch (SocketTimeoutException timeout) {
                    continue; // keep listening until the deadline, not the first gap
                }
                String body = new String(
                    reply.getData(), reply.getOffset(), reply.getLength(), StandardCharsets.UTF_8);
                String address = reply.getAddress().getHostAddress();
                String name = friendlyName(body);
                // A device that answered a webOS-specific search is a TV; keep
                // the more specific label if two answers arrive from one box.
                if (!found.containsKey(address) || (name != null && found.get(address) == null)) {
                    found.put(address, name);
                }
            }
        } catch (Exception err) {
            error = err.getMessage();
        } finally {
            if (lock != null) {
                try { lock.release(); } catch (Exception ignored) { }
            }
        }

        if (found.isEmpty() && error != null) {
            call.reject("Could not search the network: " + error);
            return;
        }

        JSArray devices = new JSArray();
        for (Map.Entry<String, String> entry : found.entrySet()) {
            JSObject device = new JSObject();
            device.put("address", entry.getKey());
            device.put("name", entry.getValue() == null ? "" : entry.getValue());
            device.put("likelyTv", entry.getValue() != null
                && entry.getValue().toLowerCase(Locale.ROOT).contains("webos"));
            devices.put(device);
        }
        JSObject ret = new JSObject();
        ret.put("devices", devices);
        call.resolve(ret);
    }

    /**
     * Pull something human out of an SSDP reply. The SERVER header is where LG
     * puts "WebOS", which is the one reliable signal that an answering box is a
     * television and not a printer.
     */
    private static String friendlyName(String body) {
        String server = header(body, "SERVER");
        String usn = header(body, "USN");
        if (server != null && server.toLowerCase(Locale.ROOT).contains("webos")) return server;
        if (usn != null && usn.toLowerCase(Locale.ROOT).contains("lge")) return "LG " + usn;
        return server;
    }

    private static String header(String body, String name) {
        for (String line : body.split("\r?\n")) {
            int colon = line.indexOf(':');
            if (colon <= 0) continue;
            if (line.substring(0, colon).trim().equalsIgnoreCase(name)) {
                return line.substring(colon + 1).trim();
            }
        }
        return null;
    }

    /** Availability probe, so the page can hide what it cannot do. */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", true);
        call.resolve(ret);
    }
}
