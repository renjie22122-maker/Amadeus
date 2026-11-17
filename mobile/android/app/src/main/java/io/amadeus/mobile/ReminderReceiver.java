package io.amadeus.mobile;

import android.app.*;
import android.content.*;
import org.json.*;

public final class ReminderReceiver extends BroadcastReceiver {
  static PendingIntent intent(Context c, String id) {
    return PendingIntent.getBroadcast(
        c,
        0,
        new Intent(c, ReminderReceiver.class)
            .setData(android.net.Uri.parse("amadeus-reminder:" + id))
            .putExtra("id", id),
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  static void schedule(Context c, JSONObject r) throws Exception {
    c.getSystemService(AlarmManager.class)
        .setAndAllowWhileIdle(
            AlarmManager.RTC_WAKEUP, r.getLong("at"), intent(c, r.getString("id")));
  }

  static Object action(Context c, String capability, JSONObject args) throws Exception {
    var prefs = c.getSharedPreferences("phone-reminders", 0);
    if (capability.equals("reminder.list")) {
      JSONArray list = new JSONArray();
      for (Object raw : prefs.getAll().values()) list.put(new JSONObject(String.valueOf(raw)));
      return list;
    }
    if (capability.equals("reminder.cancel")) {
      String id = args.getString("id");
      c.getSystemService(AlarmManager.class).cancel(intent(c, id));
      prefs.edit().remove(id).commit();
      return new JSONObject().put("cancelled", true);
    }
    long at = args.getLong("at");
    String title = args.getString("title");
    if (at <= System.currentTimeMillis() || title.isBlank() || title.length() > 500)
      throw new Exception("请提供将来的提醒时间和有效标题");
    if (android.os.Build.VERSION.SDK_INT >= 33
        && c.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
            != android.content.pm.PackageManager.PERMISSION_GRANTED)
      throw new Exception("请先允许通知权限");
    JSONObject r =
        new JSONObject()
            .put("id", java.util.UUID.randomUUID().toString())
            .put("at", at)
            .put("title", title)
            .put("precision", "Android inexact alarm; battery restrictions may delay delivery");
    prefs.edit().putString(r.getString("id"), r.toString()).commit();
    try {
      schedule(c, r);
    } catch (Exception error) {
      prefs.edit().remove(r.getString("id")).commit();
      throw error;
    }
    return r;
  }

  @Override
  public void onReceive(Context c, Intent i) {
    var prefs = c.getSharedPreferences("phone-reminders", 0);
    try {
      if (Intent.ACTION_BOOT_COMPLETED.equals(i.getAction())) {
        for (Object raw : prefs.getAll().values()) {
          JSONObject r = new JSONObject(String.valueOf(raw));
          if (r.getLong("at") > System.currentTimeMillis()) schedule(c, r);
        }
        return;
      }
      String id = i.getStringExtra("id"), raw = prefs.getString(id, null);
      if (raw == null) return;
      JSONObject r = new JSONObject(raw);
      NotificationManager manager = c.getSystemService(NotificationManager.class);
      manager.createNotificationChannel(
          new NotificationChannel("reminders", "Amadeus 提醒", NotificationManager.IMPORTANCE_HIGH));
      manager.notify(
          id.hashCode(),
          new Notification.Builder(c, "reminders")
              .setSmallIcon(android.R.drawable.ic_dialog_info)
              .setContentTitle(r.getString("title"))
              .setContentText("你安排的 Amadeus 提醒")
              .setVisibility(Notification.VISIBILITY_PRIVATE)
              .setAutoCancel(true)
              .setContentIntent(
                  PendingIntent.getActivity(
                      c, 0, new Intent(c, MainActivity.class), PendingIntent.FLAG_IMMUTABLE))
              .build());
      prefs.edit().remove(id).commit();
    } catch (Exception ignored) {
    }
  }
}
