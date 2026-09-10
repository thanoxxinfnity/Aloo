package app.aloo.assistant;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        // Registered before super.onCreate: the bridge builds its plugin
        // registry during that call, so anything added afterwards is invisible
        // to JavaScript.
        registerPlugin(SystemSettingsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
