package io.amadeus.mobile;

import android.content.Context;
import java.util.*;
import org.json.*;

/** Explicitly scoped phone memory and portable character cards. */
final class MobileData {
  final Context context;

  MobileData(Context c) {
    context = c.getApplicationContext();
  }

  static String scope(JSONObject chat) {
    String project = chat.isNull("projectId") ? "" : chat.optString("projectId");
    String role = chat.optString("roleId");
    return (project.isEmpty() ? "user" : "project:" + project)
        + (role.isEmpty() ? "" : ":role:" + role);
  }

  synchronized JSONArray memories(JSONObject chat) throws Exception {
    JSONArray result = new JSONArray();
    for (Object raw : context.getSharedPreferences("phone-memories", 0).getAll().values()) {
      JSONObject item = new JSONObject(String.valueOf(raw));
      if (scope(chat).equals(item.optString("scope"))) result.put(item);
    }
    return result;
  }

  String recall(JSONObject chat, String query) throws Exception {
    if (!context.getSharedPreferences("local-model", 0).getBoolean("automaticMemory", true))
      return "";
    JSONArray all = memories(chat);
    List<JSONObject> ranked = new ArrayList<>();
    for (int i = 0; i < all.length(); i++) ranked.add(all.getJSONObject(i));
    ranked.sort(
        (a, b) ->
            Integer.compare(
                score(b.optString("content"), query), score(a.optString("content"), query)));
    JSONArray out = new JSONArray();
    int size = 0;
    for (JSONObject item : ranked) {
      if (out.length() >= 12 || size + item.toString().length() > 6000) break;
      out.put(item);
      size += item.toString().length();
    }
    return out.toString();
  }

  static int score(String text, String query) {
    int score = 0;
    text = text.toLowerCase(Locale.ROOT);
    query = query.toLowerCase(Locale.ROOT);
    for (String word : query.split("\\s+"))
      if (word.length() > 1 && text.contains(word)) score += 4;
    for (int i = 0; i + 1 < query.length(); i++)
      if (text.contains(query.substring(i, i + 2))) score++;
    return score;
  }

  synchronized Object memory(JSONObject chat, String action, JSONObject args) throws Exception {
    if (action.equals("memory.list")) return memories(chat);
    if (action.equals("memory.save")) {
      if (!context.getSharedPreferences("local-model", 0).getBoolean("automaticMemory", true))
        throw new Exception("Automatic memory is disabled");
      String content = args.getString("content").trim();
      if (content.isEmpty() || content.length() > 2000)
        throw new Exception("Memory must contain 1–2000 characters");
      JSONArray all = memories(chat);
      for (int i = 0; i < all.length(); i++)
        if (content.equals(all.getJSONObject(i).optString("content"))) return all.getJSONObject(i);
      if (all.length() >= 200)
        throw new Exception("Memory limit reached; manage existing memories first");
      String id = UUID.randomUUID().toString();
      JSONObject item =
          new JSONObject()
              .put("id", id)
              .put("scope", scope(chat))
              .put("content", content)
              .put("sourceConversationId", chat.getString("id"))
              .put("createdAt", System.currentTimeMillis());
      context
          .getSharedPreferences("phone-memories", 0)
          .edit()
          .putString(id, item.toString())
          .commit();
      return item;
    }
    String id = args.getString("id");
    String raw = context.getSharedPreferences("phone-memories", 0).getString(id, null);
    if (raw == null || !scope(chat).equals(new JSONObject(raw).optString("scope")))
      throw new Exception("Memory unavailable in this scope");
    context.getSharedPreferences("phone-memories", 0).edit().remove(id).commit();
    return new JSONObject().put("deleted", true);
  }

  JSONObject importCard(byte[] bytes) throws Exception {
    JSONObject card = parseCard(bytes);
    context
        .getSharedPreferences("phone-roles", 0)
        .edit()
        .putString(card.getString("id"), card.toString())
        .commit();
    return card;
  }

  static JSONObject parseCard(byte[] bytes) throws Exception {
    if (bytes.length > 4 * 1024 * 1024) throw new Exception("角色卡最多 4 MB");
    String json;
    if (bytes.length > 8
        && bytes[0] == (byte) 137
        && bytes[1] == 80
        && bytes[2] == 78
        && bytes[3] == 71) {
      json = null;
      java.io.DataInputStream in =
          new java.io.DataInputStream(new java.io.ByteArrayInputStream(bytes, 8, bytes.length - 8));
      while (in.available() >= 12) {
        int length = in.readInt();
        if (length < 0 || length > in.available() - 8) throw new Exception("PNG 数据不完整");
        byte[] type = new byte[4];
        in.readFully(type);
        byte[] data = new byte[length];
        in.readFully(data);
        in.readInt();
        if (new String(type, java.nio.charset.StandardCharsets.US_ASCII).equals("tEXt")) {
          int zero = 0;
          while (zero < data.length && data[zero] != 0) zero++;
          String keyword = new String(data, 0, zero, java.nio.charset.StandardCharsets.ISO_8859_1);
          if ((keyword.equals("chara") || keyword.equals("ccv3")) && zero < data.length) {
            byte[] decoded =
                java.util.Base64.getMimeDecoder()
                    .decode(java.util.Arrays.copyOfRange(data, zero + 1, data.length));
            json = new String(decoded, java.nio.charset.StandardCharsets.UTF_8);
            if (keyword.equals("ccv3")) break;
          }
        }
      }
      if (json == null) throw new Exception("PNG 中没有支持的 chara / ccv3 角色数据");
    } else json = new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
    JSONObject raw = new JSONObject(json), data = raw.optJSONObject("data");
    if (data == null) data = raw;
    String name = data.optString("name").trim();
    if (name.isEmpty() || name.length() > 100) throw new Exception("角色卡缺少有效名称");
    JSONObject card = new JSONObject().put("id", UUID.randomUUID().toString()).put("name", name);
    for (String field :
        new String[] {
          "description",
          "personality",
          "scenario",
          "first_mes",
          "mes_example",
          "system_prompt",
          "post_history_instructions"
        }) {
      String value = data.optString(field);
      if (value.length() > 24000) throw new Exception("角色字段过长");
      card.put(field, value);
    }
    if (data.optJSONObject("character_book") != null)
      card.put("character_book", data.getJSONObject("character_book"));
    if (card.toString().length() > 60000) throw new Exception("角色内容过长");
    return card;
  }

  static String world(JSONObject role, String query) throws Exception {
    JSONObject book = role.optJSONObject("character_book");
    if (book == null) return "";
    JSONArray entries = book.optJSONArray("entries"), selected = new JSONArray();
    int size = 0;
    if (entries != null)
      for (int i = 0; i < entries.length() && selected.length() < 12; i++) {
        JSONObject e = entries.getJSONObject(i);
        if (!e.optBoolean("enabled", true)) continue;
        boolean match = e.optBoolean("constant", false);
        JSONArray keys = e.optJSONArray("keys");
        if (keys != null)
          for (int k = 0; k < keys.length(); k++)
            if (!keys.optString(k).isEmpty()
                && query
                    .toLowerCase(Locale.ROOT)
                    .contains(keys.optString(k).toLowerCase(Locale.ROOT))) match = true;
        String content = e.optString("content");
        if (match && size + content.length() <= 4000) {
          selected.put(content);
          size += content.length();
        }
      }
    return selected.toString();
  }

  JSONObject role(String id) throws Exception {
    return new JSONObject(context.getSharedPreferences("phone-roles", 0).getString(id, "{}"));
  }
}
