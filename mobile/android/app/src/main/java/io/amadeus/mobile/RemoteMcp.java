package io.amadeus.mobile;

import android.content.Context;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.*;

/** Bounded MCP 2025-11-25 Streamable HTTP client. Never retries a tools/call. */
final class RemoteMcp {
  final Context context;
  final Map<String, String> sessions = new HashMap<>();
  final Set<String> initialized = new HashSet<>();

  RemoteMcp(Context context) {
    this.context = context;
  }

  JSONArray servers() throws Exception {
    JSONArray out = new JSONArray();
    for (Object raw : context.getSharedPreferences("phone-mcp", 0).getAll().values()) {
      JSONObject c = new JSONObject(String.valueOf(raw));
      c.remove("secret");
      c.remove("iv");
      out.put(c);
    }
    return out;
  }

  void save(String name, String url, String token) throws Exception {
    URI u = new URI(url.trim());
    if (!"https".equals(u.getScheme())
        || u.getHost() == null
        || u.getUserInfo() != null
        || u.getFragment() != null
        || u.getQuery() != null) throw new Exception("请输入无查询参数的 HTTPS MCP 地址");
    JSONObject c =
        new JSONObject()
            .put("id", UUID.randomUUID().toString())
            .put("name", name)
            .put("url", url.trim());
    if (!token.isBlank()) {
      javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, new AgentClient(context).key());
      c.put("iv", android.util.Base64.encodeToString(cipher.getIV(), 2))
          .put(
              "secret",
              android.util.Base64.encodeToString(
                  cipher.doFinal(token.getBytes(StandardCharsets.UTF_8)), 2));
    }
    context
        .getSharedPreferences("phone-mcp", 0)
        .edit()
        .putString(c.getString("id"), c.toString())
        .commit();
  }

  JSONObject config(String id) throws Exception {
    String raw = context.getSharedPreferences("phone-mcp", 0).getString(id, null);
    if (raw == null) throw new Exception("MCP 连接不存在");
    return new JSONObject(raw);
  }

  String credential(JSONObject config) throws Exception {
    if (!config.has("secret")) return "";
    javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
    c.init(
        javax.crypto.Cipher.DECRYPT_MODE,
        new AgentClient(context).key(),
        new javax.crypto.spec.GCMParameterSpec(
            128, android.util.Base64.decode(config.getString("iv"), 0)));
    return new String(
        c.doFinal(android.util.Base64.decode(config.getString("secret"), 0)),
        StandardCharsets.UTF_8);
  }

  synchronized JSONObject call(String server, String method, JSONObject params) throws Exception {
    JSONObject cfg = config(server);
    if (!initialized.contains(server)) {
      JSONObject init =
          exchange(
              cfg,
              "initialize",
              new JSONObject()
                  .put("protocolVersion", "2025-11-25")
                  .put("capabilities", new JSONObject())
                  .put(
                      "clientInfo",
                      new JSONObject().put("name", "Amadeus Android").put("version", "0.2.3")),
              false);
      String version = init.optString("protocolVersion");
      if (!version.equals("2025-11-25"))
        throw new Exception("此连接需支持 MCP 2025-11-25 Streamable HTTP；其他协议请使用电脑端连接");
      exchange(cfg, "notifications/initialized", new JSONObject(), true);
      sessions.putIfAbsent(server, "");
      initialized.add(server);
    }
    return exchange(cfg, method, params, false);
  }

  JSONObject exchange(JSONObject cfg, String method, JSONObject params, boolean notification)
      throws Exception {
    HttpURLConnection conn = (HttpURLConnection) new URL(cfg.getString("url")).openConnection();
    conn.setInstanceFollowRedirects(false);
    conn.setConnectTimeout(12000);
    conn.setReadTimeout(30000);
    conn.setRequestMethod("POST");
    conn.setDoOutput(true);
    conn.setRequestProperty("Content-Type", "application/json");
    conn.setRequestProperty("Accept", "application/json, text/event-stream");
    conn.setRequestProperty("MCP-Protocol-Version", "2025-11-25");
    String session = sessions.get(cfg.getString("id"));
    if (session != null && !session.isEmpty()) conn.setRequestProperty("Mcp-Session-Id", session);
    String token = credential(cfg);
    if (!token.isEmpty()) conn.setRequestProperty("Authorization", "Bearer " + token);
    String id = UUID.randomUUID().toString();
    JSONObject body =
        new JSONObject().put("jsonrpc", "2.0").put("method", method).put("params", params);
    if (!notification) body.put("id", id);
    try {
      try (OutputStream out = conn.getOutputStream()) {
        out.write(body.toString().getBytes(StandardCharsets.UTF_8));
      }
      int code = conn.getResponseCode();
      if (code < 200 || code >= 300) throw new Exception("MCP HTTP " + code + "；未自动重试操作");
      String assigned = conn.getHeaderField("Mcp-Session-Id");
      if (assigned != null) sessions.put(cfg.getString("id"), assigned);
      if (notification) return new JSONObject();
      JSONObject rpc;
      if (String.valueOf(conn.getContentType()).contains("text/event-stream")) {
        rpc = readEvents(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8), id);
      } else {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream in = conn.getInputStream()) {
          byte[] b = new byte[8192];
          int n;
          while ((n = in.read(b)) != -1) {
            if (out.size() + n > 1024 * 1024) throw new Exception("MCP 响应过大");
            out.write(b, 0, n);
          }
        }
        rpc = new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
      }
      if (!id.equals(rpc.optString("id"))) throw new Exception("MCP 请求编号不匹配");
      if (rpc.has("error"))
        throw new Exception("MCP 返回错误 " + rpc.getJSONObject("error").optInt("code"));
      return rpc.getJSONObject("result");
    } finally {
      conn.disconnect();
    }
  }

  static JSONObject readEvents(Reader reader, String id) throws Exception {
    StringBuilder line = new StringBuilder(), event = new StringBuilder();
    int count = 0, ch;
    long started = System.nanoTime();
    while ((ch = reader.read()) != -1) {
      if (++count > 1024 * 1024 || System.nanoTime() - started > 30_000_000_000L)
        throw new IOException("MCP 响应超出限制");
      if (ch == '\r') continue;
      if (ch != '\n') {
        line.append((char) ch);
        continue;
      }
      String value = line.toString();
      line.setLength(0);
      if (value.startsWith("data:")) event.append(value.substring(5).trim()).append('\n');
      if (value.isEmpty() && event.length() > 0) {
        JSONObject result = new JSONObject(event.toString());
        event.setLength(0);
        if (id.equals(result.optString("id"))) return result;
      }
    }
    throw new IOException("MCP 未返回对应请求结果；未自动重试");
  }

  Object action(JSONObject args) throws Exception {
    String server = args.getString("serverId"), action = args.optString("action", "tools/list");
    if (!Arrays.asList(
            "tools/list",
            "tools/call",
            "resources/list",
            "resources/read",
            "prompts/list",
            "prompts/get")
        .contains(action)) throw new Exception("不支持的 MCP 操作");
    JSONObject params = args.optJSONObject("params");
    if (params == null) params = new JSONObject();
    if (action.equals("tools/call")) {
      JSONObject list = call(server, "tools/list", new JSONObject());
      JSONArray tools = list.optJSONArray("tools");
      boolean found = false;
      if (tools != null)
        for (int i = 0; i < tools.length(); i++)
          if (tools.getJSONObject(i).optString("name").equals(params.optString("name")))
            found = true;
      if (!found) throw new Exception("工具不在当前可发现的工具列表中");
    }
    return call(server, action, params);
  }
}
