package io.amadeus.mobile;

import android.content.*;
import android.hardware.*;
import android.location.*;
import android.os.*;
import java.util.concurrent.*;
import org.json.*;

final class PhoneSensors {
  static Object sample(Context c, String kind) throws Exception {
    if (!java.util.Arrays.asList("gravity", "gyroscope", "accelerometer").contains(kind))
      throw new Exception("不支持的传感器类型");
    SensorManager manager = c.getSystemService(SensorManager.class);
    int type =
        kind.equals("gravity")
            ? Sensor.TYPE_GRAVITY
            : kind.equals("gyroscope") ? Sensor.TYPE_GYROSCOPE : Sensor.TYPE_ACCELEROMETER;
    Sensor sensor = manager.getDefaultSensor(type);
    if (sensor == null) throw new Exception("此设备没有该传感器");
    HandlerThread thread = new HandlerThread("Amadeus-sensor");
    thread.start();
    CompletableFuture<JSONObject> result = new CompletableFuture<>();
    SensorEventListener listener =
        new SensorEventListener() {
          public void onAccuracyChanged(Sensor s, int accuracy) {}

          public void onSensorChanged(SensorEvent e) {
            try {
              JSONArray values = new JSONArray();
              for (float f : e.values) values.put((double) f);
              result.complete(
                  new JSONObject()
                      .put("sensor", sensor.getName())
                      .put("type", kind)
                      .put("values", values)
                      .put("units", kind.equals("gyroscope") ? "rad/s" : "m/s²")
                      .put("accuracy", e.accuracy)
                      .put("measuredAt", System.currentTimeMillis()));
            } catch (Exception error) {
              result.completeExceptionally(error);
            }
          }
        };
    try {
      if (!manager.registerListener(
          listener, sensor, SensorManager.SENSOR_DELAY_NORMAL, new Handler(thread.getLooper())))
        throw new Exception("无法读取传感器");
      return result.get(5, TimeUnit.SECONDS);
    } finally {
      manager.unregisterListener(listener);
      thread.quitSafely();
    }
  }

  static Object location(Context c) throws Exception {
    LocationManager manager = c.getSystemService(LocationManager.class);
    boolean fine =
        c.checkSelfPermission("android.permission.ACCESS_FINE_LOCATION")
            == android.content.pm.PackageManager.PERMISSION_GRANTED;
    String provider =
        manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
            ? LocationManager.NETWORK_PROVIDER
            : fine && manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
                ? LocationManager.GPS_PROVIDER
                : null;
    if (provider == null) throw new Exception("请开启定位服务并授予定位权限");
    CancellationSignal signal = new CancellationSignal();
    CompletableFuture<Location> result = new CompletableFuture<>();
    manager.getCurrentLocation(provider, signal, c.getMainExecutor(), result::complete);
    try {
      Location l = result.get(10, TimeUnit.SECONDS);
      if (l == null) throw new Exception("暂时无法定位");
      return new JSONObject()
          .put("latitude", l.getLatitude())
          .put("longitude", l.getLongitude())
          .put("accuracyMeters", l.getAccuracy())
          .put("measuredAt", l.getTime());
    } finally {
      signal.cancel();
    }
  }
}
