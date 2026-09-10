package app.aloo.assistant;

import android.content.ComponentName;
import android.content.Intent;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Opens Android's own settings screens from the WebView.
 *
 * WHY THIS IS "OPEN" AND NOT "TURN ON" — the hotspot especially
 * -----------------------------------------------------------------------
 * A normal Android app CANNOT switch the internet-sharing hotspot on. That is
 * not an oversight to work around, it is deliberate:
 *
 *   • WifiManager.setWifiApEnabled() was removed from the SDK in Android 6 and
 *     blocked for third-party apps in Android 7. Every "hotspot plugin" still
 *     floating around npm calls it by reflection and silently fails on anything
 *     modern.
 *
 *   • TetheringManager.startTethering() is the current API and is gated behind
 *     TETHER_PRIVILEGED, whose protection level is signature|privileged. Only
 *     apps signed with the platform key or shipped in the system image qualify.
 *
 *   • WifiManager.startLocalOnlyHotspot() IS callable, but it is a different
 *     feature wearing the same word: the system picks the SSID and password,
 *     there is NO internet sharing, and it shuts down when the app leaves the
 *     foreground. It is for peer-to-peer transfer between two apps. Wiring it
 *     to "turn on my hotspot" would also cost a location permission, and would
 *     produce a hotspot with no internet — the one thing the user wants.
 *
 * So the honest maximum is to land the user on the exact screen with the
 * toggle. That turns four navigations into one tap, and it works on every
 * device and every Android version without a single extra permission.
 *
 * The full-automation routes exist but need the user to opt in outside the app
 * (Shizuku via wireless debugging, a device-owner provisioning, or root), which
 * is not something an assistant should arrange behind their back.
 */
@CapacitorPlugin(name = "SystemSettings")
public class SystemSettingsPlugin extends Plugin {

    /**
     * The tether screen has no public Settings.ACTION_* constant, so it is
     * reached by a chain of decreasing specificity. Vendors move this screen
     * around (Samsung, Xiaomi and Oppo all differ), which is why a plain
     * ComponentName is not enough on its own and a guaranteed-present fallback
     * sits at the end.
     */
    private static final String[] HOTSPOT_TARGETS = {
        "android.settings.TETHER_SETTINGS",
    };

    private static final ComponentName TETHER_COMPONENT =
        new ComponentName("com.android.settings", "com.android.settings.TetherSettings");

    @PluginMethod
    public void openHotspot(PluginCall call) {
        for (String action : HOTSPOT_TARGETS) {
            if (launch(new Intent(action))) {
                call.resolve(result(true, "tether"));
                return;
            }
        }
        Intent direct = new Intent(Intent.ACTION_MAIN);
        direct.setComponent(TETHER_COMPONENT);
        if (launch(direct)) {
            call.resolve(result(true, "tether-component"));
            return;
        }
        // Always present, on every Android since API 1.
        if (launch(new Intent(Settings.ACTION_WIRELESS_SETTINGS))) {
            call.resolve(result(true, "wireless"));
            return;
        }
        call.reject("Could not open the hotspot settings on this device.");
    }

    @PluginMethod
    public void openScreen(PluginCall call) {
        String which = call.getString("screen", "");
        String action;
        switch (which) {
            case "wifi": action = Settings.ACTION_WIFI_SETTINGS; break;
            case "bluetooth": action = Settings.ACTION_BLUETOOTH_SETTINGS; break;
            case "data": action = Settings.ACTION_DATA_ROAMING_SETTINGS; break;
            case "airplane": action = Settings.ACTION_AIRPLANE_MODE_SETTINGS; break;
            case "location": action = Settings.ACTION_LOCATION_SOURCE_SETTINGS; break;
            case "sound": action = Settings.ACTION_SOUND_SETTINGS; break;
            case "display": action = Settings.ACTION_DISPLAY_SETTINGS; break;
            case "tts": action = "com.android.settings.TTS_SETTINGS"; break;
            case "battery": action = Settings.ACTION_BATTERY_SAVER_SETTINGS; break;
            default:
                call.reject("Unknown settings screen: " + which);
                return;
        }
        if (launch(new Intent(action))) {
            call.resolve(result(true, which));
        } else {
            call.reject("This device has no screen for: " + which);
        }
    }

    /**
     * Try an intent, reporting whether it actually went anywhere.
     *
     * resolveActivity() is checked first because starting an unresolvable
     * intent throws, and a vendor ROM missing one of these screens should
     * degrade to the next candidate rather than crash the app.
     */
    private boolean launch(Intent intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            if (intent.resolveActivity(getContext().getPackageManager()) == null) return false;
            getContext().startActivity(intent);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private JSObject result(boolean opened, String via) {
        JSObject o = new JSObject();
        o.put("opened", opened);
        o.put("via", via);
        return o;
    }
}
