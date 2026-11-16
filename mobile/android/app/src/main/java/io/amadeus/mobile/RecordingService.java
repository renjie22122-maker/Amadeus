package io.amadeus.mobile;

import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.media.MediaRecorder;
import android.os.*;
import java.io.File;

public class RecordingService extends Service {
  MediaRecorder recorder;

  @Override
  public int onStartCommand(Intent intent, int flags, int id) {
    if (intent != null && "stop".equals(intent.getAction())) {
      stopSelf();
      return START_NOT_STICKY;
    }
    if (recorder != null) return START_NOT_STICKY;
    if (checkSelfPermission("android.permission.RECORD_AUDIO")
        != PackageManager.PERMISSION_GRANTED) {
      stopSelf();
      return START_NOT_STICKY;
    }
    var manager = getSystemService(NotificationManager.class);
    manager.createNotificationChannel(
        new NotificationChannel(
            "recording", "Microphone recording", NotificationManager.IMPORTANCE_HIGH));
    var stop =
        PendingIntent.getService(
            this,
            2,
            new Intent(this, RecordingService.class).setAction("stop"),
            PendingIntent.FLAG_IMMUTABLE);
    startForeground(
        2,
        new Notification.Builder(this, "recording")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Amadeus 正在录音")
            .setContentText("仅录制麦克风；点击停止")
            .setContentIntent(stop)
            .setOngoing(true)
            .addAction(new Notification.Action.Builder(null, "停止录音", stop).build())
            .build());
    try {
      File directory = new File(getExternalFilesDir(null), "recordings");
      directory.mkdirs();
      File file = new File(directory, "Recording-" + System.currentTimeMillis() + ".m4a");
      recorder = Build.VERSION.SDK_INT >= 31 ? new MediaRecorder(this) : new MediaRecorder();
      recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
      recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
      recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
      recorder.setAudioEncodingBitRate(96000);
      recorder.setAudioSamplingRate(44100);
      recorder.setOutputFile(file);
      recorder.setMaxDuration(3600000);
      recorder.setOnInfoListener(
          (r, what, extra) -> {
            if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) stopSelf();
          });
      recorder.prepare();
      recorder.start();
    } catch (Exception e) {
      manager.notify(
          3,
          new Notification.Builder(this, "recording")
              .setSmallIcon(android.R.drawable.ic_dialog_alert)
              .setContentTitle("录音失败")
              .setContentText(e.getMessage())
              .build());
      stopSelf();
    }
    return START_NOT_STICKY;
  }

  @Override
  public void onDestroy() {
    if (recorder != null) {
      try {
        recorder.stop();
      } catch (Exception ignored) {
      }
      recorder.release();
      recorder = null;
    }
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
