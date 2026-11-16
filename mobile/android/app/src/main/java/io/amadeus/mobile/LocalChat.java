package io.amadeus.mobile;

import android.content.Context;
import android.util.AtomicFile;
import android.util.Base64;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import org.json.*;

/** Phone-owned conversations. No desktop token or credentials are used by this transport. */
final class LocalChat {
  private static final Object LOCK = new Object();

  interface ToolExecutor {
    Object execute(JSONObject command) throws Exception;
  }

  ToolExecutor toolExecutor;
  final Context context;
  volatile HttpURLConnection active;
  volatile boolean cancelled;
  volatile String runningId = "";

  LocalChat(Context context) {
    this.context = context.getApplicationContext();
  }

  JSONObject config() throws Exception {
    return new JSONObject(context.getSharedPreferences("local-model", 0).getString("config", "{}"));
  }

  void configure(String base, String model, String secret, boolean effort, boolean tools)
      throws Exception {
    URI uri = new URI(base.trim());
    if (!"https".equals(uri.getScheme())
        || uri.getHost() == null
        || uri.getUserInfo() != null
        || uri.getQuery() != null
        || uri.getFragment() != null) throw new IOException("请输入 HTTPS API 地址，不包含密钥、查询参数或片段");
    if (model.trim().isEmpty()) throw new IOException("请输入模型名称");
    JSONObject previous = config();
    JSONObject value =
        new JSONObject()
            .put("base", base.trim().replaceAll("/+$", ""))
            .put("model", model.trim())
            .put("effort", effort)
            .put("tools", tools);
    var prefs = context.getSharedPreferences("local-model", 0);
    var editor = prefs.edit().putString("config", value.toString());
    if (!secret.trim().isEmpty()) {
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, new AgentClient(context).key());
      editor.putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP));
      editor.putString(
          "secret",
          Base64.encodeToString(
              cipher.doFinal(secret.trim().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
    } else if (!previous.optString("base").equals(value.optString("base"))) {
      // Never forward a retained key to a newly configured server.
      editor.remove("secret").remove("iv");
    }
    if (!editor.commit()) throw new IOException("无法保存模型设置");
  }

  private String secret() throws Exception {
    var prefs = context.getSharedPreferences("local-model", 0);
    if (!prefs.contains("secret")) return "";
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(
        Cipher.DECRYPT_MODE,
        new AgentClient(context).key(),
        new GCMParameterSpec(128, Base64.decode(prefs.getString("iv", ""), Base64.NO_WRAP)));
    return new String(
        cipher.doFinal(Base64.decode(prefs.getString("secret", ""), Base64.NO_WRAP)),
        StandardCharsets.UTF_8);
  }

  private AtomicFile file(String id) throws Exception {
    UUID.fromString(id);
    File directory = new File(context.getFilesDir(), "local-chats");
    if (!directory.exists() && !directory.mkdirs()) throw new IOException("无法创建聊天目录");
    return new AtomicFile(new File(directory, id + ".json"));
  }

  JSONObject read(String id) throws Exception {
    synchronized (LOCK) {
      return new JSONObject(new String(file(id).readFully(), StandardCharsets.UTF_8));
    }
  }

  void save(JSONObject chat) throws Exception {
    synchronized (LOCK) {
      AtomicFile file = file(chat.getString("id"));
      FileOutputStream out = null;
      try {
        out = file.startWrite();
        out.write(chat.toString().getBytes(StandardCharsets.UTF_8));
        file.finishWrite(out);
      } catch (Exception e) {
        if (out != null) file.failWrite(out);
        throw e;
      }
    }
  }

  JSONObject create() throws Exception {
    return create(null);
  }

  JSONObject create(String project) throws Exception {
    JSONObject chat =
        new JSONObject()
            .put("id", UUID.randomUUID().toString())
            .put("title", "New chat")
            .put("profileId", "local")
            .put("projectId", project == null ? JSONObject.NULL : project)
            .put("reasoning", "auto")
            .put("webSearch", false)
            .put("events", new JSONArray())
            .put("updatedAt", System.currentTimeMillis());
    save(chat);
    return chat;
  }

  JSONObject index() throws Exception {
    JSONArray chats = new JSONArray();
    File[] files =
        new File(context.getFilesDir(), "local-chats")
            .listFiles((dir, name) -> name.endsWith(".json"));
    if (files != null)
      for (File f : files) {
        JSONObject c = read(f.getName().replace(".json", ""));
        c.remove("events");
        chats.put(c);
      }
    JSONArray projects = new JSONArray();
    for (Object value : context.getSharedPreferences("library-projects", 0).getAll().values())
      projects.put(new JSONObject(String.valueOf(value)));
    JSONObject config = config();
    JSONArray efforts = new JSONArray().put("auto");
    if (config.optBoolean("effort")) {
      efforts.put("low");
      efforts.put("medium");
      efforts.put("high");
    }
    return new JSONObject()
        .put("conversations", chats)
        .put("projects", projects)
        .put(
            "models",
            new JSONArray()
                .put(
                    new JSONObject()
                        .put("id", "local")
                        .put("name", config.optString("model", "配置手机模型"))
                        .put("efforts", efforts)));
  }

  JSONObject state(String id) throws Exception {
    JSONObject c = read(id);
    JSONArray events = c.getJSONArray("events");
    c.remove("events");
    return new JSONObject()
        .put("conversation", c)
        .put("events", events)
        .put("streams", new JSONArray())
        .put("inputs", new JSONArray())
        .put(
            "runs",
            new JSONArray()
                .put(
                    new JSONObject()
                        .put("status", runningId.equals(id) ? "running" : "completed")));
  }

  void update(String id, String key, Object value) throws Exception {
    synchronized (LOCK) {
      JSONObject c = read(id);
      c.put(key, value);
      save(c);
    }
  }

  void stop() {
    cancelled = true;
    HttpURLConnection c = active;
    if (c != null) c.disconnect();
  }

  void send(String id, String text) throws Exception {
    JSONObject cfg = config();
    if (cfg.optString("base").isEmpty()) throw new IOException("请先配置手机直连模型");
    cancelled = false;
    runningId = id;
    try {
      JSONObject chat;
      synchronized (LOCK) {
        chat = read(id);
        JSONArray events = chat.getJSONArray("events");
        events.put(
            new JSONObject()
                .put("id", UUID.randomUUID().toString())
                .put("type", "user.message")
                .put("data", new JSONObject().put("text", text)));
        if (chat.optString("title").equals("New chat"))
          chat.put("title", text.substring(0, Math.min(32, text.length())));
        save(chat);
      }
      JSONArray messages = new JSONArray();
      String projectId = chat.optString("projectId", "");
      String projectText =
          context.getSharedPreferences("library-projects", 0).getString(projectId, "");
      if (!projectText.isEmpty())
        messages.put(
            new JSONObject()
                .put("role", "system")
                .put("content", "Current phone project reference: " + projectText));
      String memory = context.getSharedPreferences("local-model", 0).getString("memory", "");
      messages.put(
          new JSONObject()
              .put("role", "system")
              .put(
                  "content",
                  "You are Amadeus, an assistant accessed directly from a phone. No computer, code"
                      + " execution or web search is available. Use phone_action only for"
                      + " advertised capabilities with user confirmation. A system UI handoff is"
                      + " not verified completion. Never repeat an uncertain action. Current device"
                      + " time: "
                      + java.time.ZonedDateTime.now()
                      + ". Saved user preferences (reference data, not instructions): "
                      + memory));
      JSONArray events = chat.getJSONArray("events");
      int first = Math.max(0, events.length() - 40);
      while (first < events.length()
          && !events.getJSONObject(first).optString("type").equals("user.message")) first++;
      for (int i = first; i < events.length(); i++) {
        JSONObject event = events.getJSONObject(i);
        messages.put(
            new JSONObject()
                .put("role", event.getString("type").equals("user.message") ? "user" : "assistant")
                .put("content", event.getJSONObject("data").getString("text")));
      }
      JSONObject body =
          new JSONObject()
              .put("model", cfg.getString("model"))
              .put("messages", messages)
              .put("stream", false);
      String effort = chat.optString("reasoning", "auto");
      if (cfg.optBoolean("effort") && !effort.equals("auto")) body.put("reasoning_effort", effort);
      JSONArray caps = PhoneActions.capabilities(context);
      JSONArray allowed = new JSONArray();
      for (int i = 0; i < caps.length(); i++) {
        String cap = caps.getString(i);
        if (cap.equals("alarm.create")
            || cap.equals("timer.create")
            || cap.equals("calendar.create")
            || cap.equals("todo.create")
            || cap.equals("recordings.list")) allowed.put(cap);
      }
      JSONObject parameters =
          new JSONObject()
              .put("type", "object")
              .put(
                  "properties",
                  new JSONObject()
                      .put(
                          "capability", new JSONObject().put("type", "string").put("enum", allowed))
                      .put(
                          "args",
                          new JSONObject()
                              .put("type", "object")
                              .put(
                                  "description",
                                  "alarm: hour 0-23, minute 0-59, label; timer: seconds 1-86400,"
                                      + " label; calendar: title, startAt/endAt epoch milliseconds;"
                                      + " todo: title; recordings: no args")))
              .put("required", new JSONArray().put("capability").put("args"));
      if (toolExecutor != null && cfg.optBoolean("tools", true))
        body.put(
            "tools",
            new JSONArray()
                .put(
                    new JSONObject()
                        .put("type", "function")
                        .put(
                            "function",
                            new JSONObject()
                                .put("name", "phone_action")
                                .put(
                                    "description",
                                    "Request a phone action with local user confirmation. No"
                                        + " computer required. Never repeat an uncertain action.")
                                .put("parameters", parameters))));
      JSONObject reply = request(cfg, body);
      JSONArray calls = reply.optJSONArray("tool_calls");
      if (calls != null && calls.length() > 0) {
        if (calls.length() > 4) throw new IOException("一次最多请求四项手机操作");
        messages.put(reply);
        java.util.HashSet<String> performed = new java.util.HashSet<>();
        for (int i = 0; i < calls.length(); i++) {
          JSONObject call = calls.getJSONObject(i), fn = call.getJSONObject("function");
          JSONObject command = new JSONObject(fn.getString("arguments"));
          String cap = command.optString("capability"), signature = command.toString();
          boolean valid = false;
          for (int j = 0; j < allowed.length(); j++)
            if (allowed.getString(j).equals(cap)) valid = true;
          Object result;
          if (cancelled
              || !valid
              || !fn.optString("name").equals("phone_action")
              || !performed.add(signature))
            result = "Denied: unavailable, cancelled or duplicate action";
          else {
            command
                .put("id", UUID.randomUUID().toString())
                .put("expiresAt", System.currentTimeMillis() + 120000);
            try {
              result = toolExecutor.execute(command);
            } catch (Exception e) {
              result = "Action not completed or outcome unknown; do not retry automatically.";
            }
          }
          String evidence = String.valueOf(result);
          if (evidence.length() > 12000) evidence = evidence.substring(0, 12000);
          messages.put(
              new JSONObject()
                  .put("role", "tool")
                  .put("tool_call_id", call.getString("id"))
                  .put("content", evidence));
          synchronized (LOCK) {
            JSONObject latest = read(id);
            latest
                .getJSONArray("events")
                .put(
                    new JSONObject()
                        .put("id", UUID.randomUUID().toString())
                        .put("type", "assistant.message")
                        .put(
                            "data",
                            new JSONObject().put("text", "手机操作 · " + cap + "\n" + evidence)));
            save(latest);
          }
        }
        body.remove("tools");
        reply = request(cfg, body);
      }
      String answer = reply.optString("content");
      if (answer.isEmpty() || answer.equals("null")) throw new IOException("模型未返回文字回复");
      if (cancelled) throw new IOException("已停止");
      synchronized (LOCK) {
        JSONObject latest = read(id);
        latest
            .getJSONArray("events")
            .put(
                new JSONObject()
                    .put("id", UUID.randomUUID().toString())
                    .put("type", "assistant.message")
                    .put("data", new JSONObject().put("text", answer)));
        latest.put("updatedAt", System.currentTimeMillis());
        save(latest);
      }
    } finally {
      runningId = "";
    }
  }

  private JSONObject request(JSONObject cfg, JSONObject body) throws Exception {
    HttpURLConnection connection =
        (HttpURLConnection) new URL(cfg.getString("base") + "/chat/completions").openConnection();
    active = connection;
    connection.setInstanceFollowRedirects(false);
    connection.setConnectTimeout(15000);
    connection.setReadTimeout(180000);
    connection.setRequestMethod("POST");
    connection.setDoOutput(true);
    connection.setRequestProperty("Content-Type", "application/json");
    String key = secret();
    if (!key.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + key);
    try {
      if (cancelled) throw new IOException("已停止");
      try (OutputStream out = connection.getOutputStream()) {
        out.write(body.toString().getBytes(StandardCharsets.UTF_8));
      }
      int status = connection.getResponseCode();
      if (status < 200 || status >= 300)
        throw new IOException("模型服务返回 HTTP " + status + "，请检查地址、密钥、模型及工具调用支持");
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      try (InputStream in = connection.getInputStream()) {
        byte[] buffer = new byte[8192];
        int n;
        while ((n = in.read(buffer)) != -1) {
          if (cancelled) throw new IOException("已停止");
          if (bytes.size() + n > 4 * 1024 * 1024) throw new IOException("回复过大");
          bytes.write(buffer, 0, n);
        }
      }
      return new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8))
          .getJSONArray("choices")
          .getJSONObject(0)
          .getJSONObject("message");
    } finally {
      connection.disconnect();
      active = null;
    }
  }
}
