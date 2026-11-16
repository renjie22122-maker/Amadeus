package io.amadeus.mobile;

import android.app.*;
import android.content.*;
import android.graphics.PixelFormat;
import android.os.*;
import android.provider.Settings;
import android.view.*;
import android.widget.*;
import java.util.concurrent.*;
import org.json.*;

public class DotService extends Service {
  public static volatile boolean active;
  ScheduledExecutorService worker;
  TextView dot;
  WindowManager manager;
  static final String CHANNEL = "amadeus-session";

  @Override
  public void onCreate() {
    super.onCreate();
    active = true;
    var nm = getSystemService(NotificationManager.class);
    nm.createNotificationChannel(
        new NotificationChannel(
            CHANNEL, "Amadeus session", NotificationManager.IMPORTANCE_DEFAULT));
    Intent stop = new Intent(this, DotService.class).setAction("stop");
    Notification notification =
        new Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Amadeus 已连接")
            .setContentText("点击打开；停止后不再接收手机操作。")
            .setContentIntent(
                PendingIntent.getActivity(
                    this,
                    0,
                    new Intent(this, MainActivity.class),
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
            .addAction(
                new Notification.Action.Builder(
                        null,
                        "停止",
                        PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE))
                    .build())
            .setOngoing(true)
            .build();
    startForeground(1, notification);
    if (Settings.canDrawOverlays(this)) {
      manager = getSystemService(WindowManager.class);
      dot = new TextView(this);
      dot.setText("●");
      dot.setTextColor(0xffb8a2ff);
      dot.setTextSize(44);
      dot.setContentDescription("Open Amadeus");
      var params =
          new WindowManager.LayoutParams(
              160,
              160,
              WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
              WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
              PixelFormat.TRANSLUCENT);
      params.gravity = Gravity.TOP | Gravity.END;
      params.y = 240;
      dot.setOnClickListener(
          v ->
              startActivity(
                  new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)));
      manager.addView(dot, params);
    }
    // Recovered in-flight commands are uncertain. Do not execute them again after process death.
    var prefs = AgentClient.commandPreferences(this);
    for (var entry : prefs.getAll().entrySet())
      if (entry.getKey().startsWith("started:")
          && !prefs.contains("result:" + entry.getKey().substring(8)))
        finish(
            this,
            entry.getKey().substring(8),
            "unknown",
            "Phone process interrupted; inspect before retrying");
    worker = Executors.newSingleThreadScheduledExecutor();
    worker.scheduleWithFixedDelay(this::poll, 0, 5, TimeUnit.SECONDS);
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && "stop".equals(intent.getAction())) stopSelf();
    return START_NOT_STICKY;
  }

  Boolean connectionHealthy;

  void connectionStatus(boolean healthy) {
    if (connectionHealthy != null && connectionHealthy == healthy) return;
    connectionHealthy = healthy;
    getSystemService(NotificationManager.class)
        .notify(
            1,
            new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(healthy ? "Amadeus 常驻连接已启动" : "Amadeus 等待连接")
                .setContentText(healthy ? "手机已连接电脑 · 点击查看聊天" : "网络暂不可用，等待恢复；操作不会自动重复执行")
                .setContentIntent(
                    PendingIntent.getActivity(
                        this,
                        0,
                        new Intent(this, MainActivity.class),
                        PendingIntent.FLAG_IMMUTABLE))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .addAction(
                    new Notification.Action.Builder(
                            null,
                            "停止",
                            PendingIntent.getService(
                                this,
                                1,
                                new Intent(this, DotService.class).setAction("stop"),
                                PendingIntent.FLAG_IMMUTABLE))
                        .build())
                .build());
  }

  void poll() {
    try {
      AgentClient client = new AgentClient(this).freeze();
      var prefs = AgentClient.commandPreferences(this);
      for (var entry : prefs.getAll().entrySet())
        if (entry.getKey().startsWith("result:")) {
          String key = entry.getKey().substring(7);
          client.call("/v1/device/results/" + key, new JSONObject((String) entry.getValue()));
          prefs.edit().remove(entry.getKey()).remove("started:" + key).commit();
        }
      JSONObject response =
          client.call(
              "/v1/device/poll",
              new JSONObject().put("capabilities", PhoneActions.capabilities(this)));
      if (!client.matchesCurrent() || !active) return;
      connectionStatus(true);
      long latest = response.optLong("latestEventId", 0),
          previous = prefs.getLong("latestEventId", 0);
      if (latest > previous) {
        prefs.edit().putLong("latestEventId", latest).commit();
        if (previous > 0)
          getSystemService(NotificationManager.class)
              .notify(
                  4,
                  new Notification.Builder(this, CHANNEL)
                      .setSmallIcon(android.R.drawable.ic_dialog_info)
                      .setContentTitle("Amadeus 有新进展")
                      .setContentText("点击查看助手的回复")
                      .setVisibility(Notification.VISIBILITY_PRIVATE)
                      .setContentIntent(
                          PendingIntent.getActivity(
                              this,
                              0,
                              new Intent(this, MainActivity.class),
                              PendingIntent.FLAG_IMMUTABLE))
                      .setAutoCancel(true)
                      .build());
      }
      JSONObject command = response.optJSONObject("command");
      if (command == null || !active) return;
      String key = command.getString("id");
      if (prefs.contains("started:" + key) || prefs.contains("done:" + key)) return;
      prefs.edit().putBoolean("started:" + key, true).commit();
      String capability = command.getString("capability");
      if (capability.equals("sensor.read")
          || capability.equals("location.current")
          || capability.startsWith("screen.")
          || capability.startsWith("gallery.")
          || capability.endsWith(".list")
          || capability.equals("todo.create")) {
        try {
          finish(this, key, "completed", PhoneActions.run(this, command));
        } catch (Exception e) {
          finish(this, key, "unknown", e.getMessage());
        }
      } else {
        prefs.edit().putString("pending:" + key, command.toString()).commit();
        Intent intent = new Intent(this, MainActivity.class).putExtra("commandId", key);
        var pending =
            PendingIntent.getActivity(
                this,
                key.hashCode(),
                intent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        getSystemService(NotificationManager.class)
            .notify(
                key.hashCode(),
                new Notification.Builder(this, CHANNEL)
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setContentTitle("Amadeus 手机操作请求")
                    .setContentText(capability + " · 点击查看并执行")
                    .setContentIntent(pending)
                    .setAutoCancel(true)
                    .build());
      }
    } catch (Exception e) {
      connectionStatus(false);
    }
  }

  static void finish(Context c, String key, String status, Object result) {
    try {
      AgentClient.commandPreferences(c)
          .edit()
          .putString(
              "result:" + key,
              new JSONObject().put("status", status).put("result", result).toString())
          .putBoolean("done:" + key, true)
          .remove("pending:" + key)
          .commit();
    } catch (Exception ignored) {
    }
  }

  @Override
  public void onDestroy() {
    active = false;
    if (worker != null) worker.shutdownNow();
    if (dot != null) manager.removeView(dot);
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
