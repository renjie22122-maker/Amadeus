package io.amadeus.mobile;

import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.*;
import org.json.*;

final class PhoneActions {
  static boolean galleryAllowed(Context c) {
    return c.checkSelfPermission(
                Build.VERSION.SDK_INT >= 33
                    ? "android.permission.READ_MEDIA_IMAGES"
                    : "android.permission.READ_EXTERNAL_STORAGE")
            == PackageManager.PERMISSION_GRANTED
        || (Build.VERSION.SDK_INT >= 34
            && c.checkSelfPermission("android.permission.READ_MEDIA_VISUAL_USER_SELECTED")
                == PackageManager.PERMISSION_GRANTED);
  }

  static JSONArray capabilities(Context c) {
    JSONArray result = new JSONArray();
    for (String name :
        new String[] {
          "alarm.create",
          "timer.create",
          "calendar.create",
          "todo.create",
          "reminder.create",
          "reminder.list",
          "reminder.cancel",
          "sms.compose",
          "maps.open",
          "sensor.read",
          "permissions.request"
        }) result.put(name);
    if (galleryAllowed(c)) {
      result.put("gallery.list");
      result.put("gallery.preview");
      result.put("gallery.collect");
      result.put("gallery.collections");
    }
    if (c.checkSelfPermission("android.permission.READ_SMS") == PackageManager.PERMISSION_GRANTED)
      result.put("sms.list");
    if (c.checkSelfPermission("android.permission.READ_CALL_LOG")
        == PackageManager.PERMISSION_GRANTED) result.put("calls.list");
    if (c.checkSelfPermission("android.permission.READ_CONTACTS")
        == PackageManager.PERMISSION_GRANTED) result.put("contacts.list");
    if (c.checkSelfPermission("android.permission.ACCESS_COARSE_LOCATION")
            == PackageManager.PERMISSION_GRANTED
        || c.checkSelfPermission("android.permission.ACCESS_FINE_LOCATION")
            == PackageManager.PERMISSION_GRANTED) result.put("location.current");
    result.put("recordings.list");
    if (c.getSharedPreferences("files", 0).contains("tree")) {
      result.put("files.list");
      result.put("files.rename");
    }
    if (ScreenService.instance != null && DotService.active)
      for (String name :
          new String[] {"screen.read", "screen.tap", "screen.swipe", "screen.back", "screen.home"})
        result.put(name);
    return result;
  }

  static Object run(Context c, JSONObject command) throws Exception {
    String capability = command.getString("capability");
    JSONObject a = command.getJSONObject("args");
    if (command.getLong("expiresAt") < System.currentTimeMillis())
      throw new Exception("Request expired; no action performed");
    if (capability.equals("permissions.request")) {
      if (!(c instanceof Activity)) throw new Exception("Open the phone app to request permission");
      String[] permissions;
      switch (a.getString("permission")) {
        case "location":
          permissions =
              new String[] {
                "android.permission.ACCESS_COARSE_LOCATION",
                "android.permission.ACCESS_FINE_LOCATION"
              };
          break;
        case "sms":
          permissions = new String[] {"android.permission.READ_SMS"};
          break;
        case "contacts":
          permissions = new String[] {"android.permission.READ_CONTACTS"};
          break;
        case "notifications":
          permissions =
              Build.VERSION.SDK_INT >= 33
                  ? new String[] {"android.permission.POST_NOTIFICATIONS"}
                  : new String[0];
          break;
        case "photos":
          permissions =
              Build.VERSION.SDK_INT >= 33
                  ? new String[] {"android.permission.READ_MEDIA_IMAGES"}
                  : new String[] {"android.permission.READ_EXTERNAL_STORAGE"};
          break;
        default:
          throw new Exception("Unsupported permission request");
      }
      ((Activity) c).runOnUiThread(() -> ((Activity) c).requestPermissions(permissions, 72));
      return new JSONObject()
          .put("status", "system_permission_requested")
          .put("granted", false)
          .put(
              "note",
              "Wait for the user to grant permission; request capabilities again on the next"
                  + " turn.");
    }
    if (capability.startsWith("reminder.")) return ReminderReceiver.action(c, capability, a);
    if (capability.equals("sensor.read"))
      return PhoneSensors.sample(c, a.optString("type", "gravity"));
    if (capability.equals("location.current")) return PhoneSensors.location(c);
    if (capability.equals("maps.open")) {
      String query = a.getString("query");
      if (query.length() > 500) throw new Exception("地图查询过长");
      c.startActivity(
          new Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(query)))
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      return new JSONObject().put("status", "handed_to_maps_app").put("verified", false);
    }
    if (capability.equals("sms.compose")) {
      String number = a.getString("number"), body = a.getString("body");
      if (!number.matches("[+0-9 ()-]{1,40}") || body.length() > 4000)
        throw new Exception("短信号码或内容无效");
      c.startActivity(
          new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(number)))
              .putExtra("sms_body", body)
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      return new JSONObject().put("status", "draft_opened_in_sms_app").put("sent", false);
    }
    if (capability.equals("gallery.preview")) {
      if (!galleryAllowed(c)) throw new Exception("Photo access not granted");
      Uri image =
          ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, a.getLong("id"));
      android.graphics.Bitmap bitmap =
          android.graphics.ImageDecoder.decodeBitmap(
              android.graphics.ImageDecoder.createSource(c.getContentResolver(), image),
              (decoder, info, source) -> {
                int width = info.getSize().getWidth(), height = info.getSize().getHeight();
                double ratio = Math.min(1.0, 640.0 / Math.max(width, height));
                decoder.setTargetSize(
                    Math.max(1, (int) (width * ratio)), Math.max(1, (int) (height * ratio)));
                decoder.setAllocator(android.graphics.ImageDecoder.ALLOCATOR_SOFTWARE);
              });
      java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
      bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 75, bytes);
      bitmap.recycle();
      return new JSONObject()
          .put(
              "image",
              "data:image/jpeg;base64,"
                  + android.util.Base64.encodeToString(
                      bytes.toByteArray(), android.util.Base64.NO_WRAP))
          .put("id", a.getLong("id"));
    }
    if (capability.equals("gallery.collections"))
      return new JSONObject(c.getSharedPreferences("albums", 0).getAll());
    if (capability.equals("gallery.collect")) {
      if (!galleryAllowed(c)) throw new Exception("Photo access not granted");
      String name = a.getString("name");
      JSONArray ids = a.getJSONArray("ids");
      if (name.isBlank() || name.length() > 100 || ids.length() > 200)
        throw new Exception("Invalid collection");
      for (int i = 0; i < ids.length(); i++) {
        Uri image =
            ContentUris.withAppendedId(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI, ids.getLong(i));
        try (var cursor =
            c.getContentResolver().query(image, new String[] {"_id"}, null, null, null)) {
          if (cursor == null || !cursor.moveToFirst())
            throw new Exception("Photo unavailable or outside allowed selection");
        }
      }
      c.getSharedPreferences("albums", 0).edit().putString(name, ids.toString()).commit();
      return new JSONObject()
          .put("collection", name)
          .put("count", ids.length())
          .put("storage", "Amadeus virtual collection; original photos are unchanged");
    }
    if (capability.equals("recordings.list")) {
      JSONArray result = new JSONArray();
      java.io.File[] files =
          new java.io.File(c.getExternalFilesDir(null), "recordings").listFiles();
      if (files != null)
        for (var file : files)
          if (result.length() < 200)
            result.put(
                new JSONObject()
                    .put("name", file.getName())
                    .put("bytes", file.length())
                    .put("modifiedAt", file.lastModified()));
      return result;
    }
    if (capability.equals("sms.list")
        || capability.equals("calls.list")
        || capability.equals("contacts.list")) {
      Uri uri;
      String[] columns;
      String sort;
      if (capability.equals("sms.list")) {
        uri = Telephony.Sms.CONTENT_URI;
        columns = new String[] {"_id", "address", "body", "date", "type", "read"};
        sort = "date DESC";
      } else if (capability.equals("calls.list")) {
        uri = CallLog.Calls.CONTENT_URI;
        columns = new String[] {"_id", "number", "date", "duration", "type"};
        sort = "date DESC";
      } else {
        uri = ContactsContract.CommonDataKinds.Phone.CONTENT_URI;
        columns = new String[] {"_id", "display_name", "data1"};
        sort = "display_name ASC";
      }
      JSONArray result = new JSONArray();
      int limit = Math.max(1, Math.min(100, a.optInt("limit", 30)));
      try (var cursor = c.getContentResolver().query(uri, columns, null, null, sort)) {
        while (cursor != null && cursor.moveToNext() && result.length() < limit) {
          JSONObject row = new JSONObject();
          for (int i = 0; i < columns.length; i++) row.put(columns[i], cursor.getString(i));
          result.put(row);
        }
      }
      return result;
    }
    if (capability.equals("files.list") || capability.equals("files.rename")) {
      Uri tree = Uri.parse(c.getSharedPreferences("files", 0).getString("tree", ""));
      String root = DocumentsContract.getTreeDocumentId(tree);
      JSONArray result = new JSONArray();
      String[] cols = {
        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_MIME_TYPE,
        DocumentsContract.Document.COLUMN_SIZE
      };
      try (var cursor =
          c.getContentResolver()
              .query(
                  DocumentsContract.buildChildDocumentsUriUsingTree(tree, root),
                  cols,
                  null,
                  null,
                  null)) {
        while (cursor != null && cursor.moveToNext() && result.length() < 200) {
          String docId = cursor.getString(0);
          result.put(
              new JSONObject()
                  .put("id", docId)
                  .put("name", cursor.getString(1))
                  .put("mime", cursor.getString(2))
                  .put("bytes", cursor.getLong(3)));
          if (capability.equals("files.rename") && docId.equals(a.getString("id"))) {
            if (!(c instanceof Activity)) throw new Exception("Local confirmation required");
            String name = a.getString("name");
            if (name.isBlank() || name.length() > 120 || name.contains("/") || name.contains("\\"))
              throw new Exception("Invalid file name");
            Uri renamed =
                DocumentsContract.renameDocument(
                    c.getContentResolver(),
                    DocumentsContract.buildDocumentUriUsingTree(tree, docId),
                    name);
            return new JSONObject().put("renamed", renamed != null);
          }
        }
      }
      if (capability.equals("files.rename"))
        throw new Exception("File not found in the selected folder");
      return result;
    }
    if (capability.startsWith("screen.")) {
      if (!DotService.active
          || ScreenService.instance == null
          || c.getSystemService(KeyguardManager.class).isKeyguardLocked())
        throw new Exception("Screen control session unavailable or phone locked");
      return ScreenService.instance.perform(capability, a);
    }
    if (capability.equals("todo.create")) {
      String title = a.getString("title");
      if (title.isBlank() || title.length() > 2000) throw new Exception("Invalid title");
      var prefs = c.getSharedPreferences("todos", 0);
      JSONArray todos = new JSONArray(prefs.getString("items", "[]"));
      todos.put(
          new JSONObject()
              .put("id", command.getString("id"))
              .put("title", title)
              .put("createdAt", System.currentTimeMillis()));
      prefs.edit().putString("items", todos.toString()).commit();
      return new JSONObject().put("saved", true).put("application", "Amadeus local todo list");
    }
    if (capability.equals("gallery.list")) {
      if (!galleryAllowed(c)) throw new Exception("Photo access not granted");
      JSONArray images = new JSONArray();
      int limit = Math.max(1, Math.min(200, a.optInt("limit", 50)));
      try (var cursor =
          c.getContentResolver()
              .query(
                  MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                  new String[] {"_id", "_display_name", "date_taken", "width", "height", "_size"},
                  null,
                  null,
                  "date_taken DESC")) {
        while (cursor != null && cursor.moveToNext() && images.length() < limit)
          images.put(
              new JSONObject()
                  .put("id", cursor.getLong(0))
                  .put("name", cursor.getString(1))
                  .put("takenAt", cursor.getLong(2))
                  .put("width", cursor.getInt(3))
                  .put("height", cursor.getInt(4))
                  .put("bytes", cursor.getLong(5)));
      }
      return new JSONObject()
          .put("images", images)
          .put("access", "Only permitted photos; metadata only; no images moved or deleted");
    }
    if (!(c instanceof Activity))
      throw new Exception("Open the notification to confirm this action");
    Intent intent;
    switch (capability) {
      case "alarm.create":
        int hour = a.getInt("hour"), minute = a.getInt("minute");
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59)
          throw new Exception("Invalid alarm time");
        intent =
            new Intent(AlarmClock.ACTION_SET_ALARM)
                .putExtra(AlarmClock.EXTRA_HOUR, hour)
                .putExtra(AlarmClock.EXTRA_MINUTES, minute)
                .putExtra(AlarmClock.EXTRA_MESSAGE, a.optString("label", "Amadeus"))
                .putExtra(AlarmClock.EXTRA_SKIP_UI, false);
        break;
      case "timer.create":
        int seconds = a.getInt("seconds");
        if (seconds < 1 || seconds > 86400) throw new Exception("Timer must be 1–86400 seconds");
        intent =
            new Intent(AlarmClock.ACTION_SET_TIMER)
                .putExtra(AlarmClock.EXTRA_LENGTH, seconds)
                .putExtra(AlarmClock.EXTRA_MESSAGE, a.optString("label", "Amadeus"))
                .putExtra(AlarmClock.EXTRA_SKIP_UI, false);
        break;
      case "calendar.create":
        long start = a.getLong("startAt"), end = a.getLong("endAt");
        if (start < 0 || end <= start) throw new Exception("Invalid calendar interval");
        intent =
            new Intent(Intent.ACTION_INSERT)
                .setData(CalendarContract.Events.CONTENT_URI)
                .putExtra(CalendarContract.Events.TITLE, a.getString("title"))
                .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, start)
                .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end);
        break;
      default:
        throw new Exception("Unsupported capability: " + capability);
    }
    c.startActivity(intent);
    return new JSONObject()
        .put("status", "handed_to_system_ui")
        .put("verified", false)
        .put("note", "User must finish confirmation in the system app; creation is not verified.");
  }
}
