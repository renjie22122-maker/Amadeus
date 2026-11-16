package io.amadeus.mobile;

import android.app.*;
import android.content.*;
import android.os.*;
import android.widget.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.*;

public class TavernActivity extends MobileScreen {
  String exportCard;

  public void onCreate(Bundle b) {
    super.onCreate(b);
    heading("酒馆", "角色、你的身份与世界设定。角色记忆独立保存，默认不调用现实工具。");
    button("＋ 创建角色", () -> edit(null));
    button(
        "导入 JSON / PNG 角色卡",
        () ->
            startActivityForResult(
                new Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .setType("*/*")
                    .addCategory(Intent.CATEGORY_OPENABLE),
                21));
    button("我的扮演身份", () -> persona());
    for (Object raw : getSharedPreferences("phone-roles", 0).getAll().values())
      try {
        JSONObject r = new JSONObject(String.valueOf(raw));
        button(
            r.optString("name"),
            () ->
                new AlertDialog.Builder(this)
                    .setTitle(r.optString("name"))
                    .setMessage(r.optString("description"))
                    .setPositiveButton(
                        "开始聊天",
                        (d, w) ->
                            startActivity(
                                new Intent(this, MainActivity.class)
                                    .addFlags(
                                        Intent.FLAG_ACTIVITY_CLEAR_TOP
                                            | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                                    .putExtra("localRoleId", r.optString("id"))))
                    .setNeutralButton(
                        "删除",
                        (d, w) ->
                            new AlertDialog.Builder(this)
                                .setMessage("删除角色卡？已有对话仍保留。")
                                .setPositiveButton(
                                    "删除",
                                    (a, z) -> {
                                      getSharedPreferences("phone-roles", 0)
                                          .edit()
                                          .remove(r.optString("id"))
                                          .apply();
                                      recreate();
                                    })
                                .setNegativeButton("取消", null)
                                .show())
                    .setNegativeButton(
                        "编辑与导出",
                        (d, w) ->
                            new AlertDialog.Builder(this)
                                .setItems(
                                    new String[] {"编辑角色", "导出 JSON 角色卡"},
                                    (a, z) -> {
                                      if (z == 0) edit(r);
                                      else {
                                        try {
                                          exportCard =
                                              new JSONObject()
                                                  .put("spec", "chara_card_v2")
                                                  .put("spec_version", "2.0")
                                                  .put("data", r)
                                                  .toString(2);
                                          startActivityForResult(
                                              new Intent(Intent.ACTION_CREATE_DOCUMENT)
                                                  .setType("application/json")
                                                  .addCategory(Intent.CATEGORY_OPENABLE)
                                                  .putExtra(
                                                      Intent.EXTRA_TITLE,
                                                      r.optString("name") + ".json"),
                                              22);
                                        } catch (Exception e) {
                                          feedback.setText(e.getMessage());
                                        }
                                      }
                                    })
                                .show())
                    .show());
      } catch (Exception ignored) {
      }
  }

  EditText add(LinearLayout box, String hint) {
    EditText e = new EditText(this);
    e.setHint(hint);
    box.addView(e);
    return e;
  }

  void edit(JSONObject existing) {
    LinearLayout box = new LinearLayout(this);
    box.setOrientation(LinearLayout.VERTICAL);
    EditText name = add(box, "角色名称"),
        description = add(box, "性格与背景"),
        first = add(box, "开场白"),
        keys = add(box, "世界设定关键词（逗号分隔）"),
        world = add(box, "关键词触发的世界设定");
    if (existing != null) {
      name.setText(existing.optString("name"));
      description.setText(existing.optString("description"));
      first.setText(existing.optString("first_mes"));
      keys.setHint("新增设定关键词（留空为常驻）");
      world.setHint("新增世界设定（已有条目保留）");
    }
    ScrollView scroll = new ScrollView(this);
    scroll.addView(box);
    AlertDialog dialog =
        new AlertDialog.Builder(this)
            .setTitle("创建角色")
            .setView(scroll)
            .setPositiveButton("保存", null)
            .setNegativeButton("取消", null)
            .create();
    dialog.setOnShowListener(
        v ->
            dialog
                .getButton(-1)
                .setOnClickListener(
                    vv -> {
                      try {
                        JSONObject card =
                            (existing == null
                                    ? new JSONObject()
                                    : new JSONObject(existing.toString()))
                                .put("name", name.getText())
                                .put("description", description.getText())
                                .put("first_mes", first.getText());
                        if (world.length() > 0) {
                          JSONArray words = new JSONArray();
                          for (String s : keys.getText().toString().split("[,，]"))
                            if (!s.trim().isEmpty()) words.put(s.trim());
                          card.put(
                              "character_book",
                              new JSONObject()
                                  .put(
                                      "entries",
                                      (existing != null
                                                  && existing.optJSONObject("character_book")
                                                      != null
                                                  && existing
                                                          .getJSONObject("character_book")
                                                          .optJSONArray("entries")
                                                      != null
                                              ? existing
                                                  .getJSONObject("character_book")
                                                  .optJSONArray("entries")
                                              : new JSONArray())
                                          .put(
                                              new JSONObject()
                                                  .put("keys", words)
                                                  .put("constant", words.length() == 0)
                                                  .put("content", world.getText()))));
                        }
                        JSONObject saved =
                            new MobileData(this)
                                .importCard(card.toString().getBytes(StandardCharsets.UTF_8));
                        if (existing != null) {
                          getSharedPreferences("phone-roles", 0)
                              .edit()
                              .remove(saved.getString("id"))
                              .putString(
                                  existing.getString("id"),
                                  saved.put("id", existing.getString("id")).toString())
                              .commit();
                        }
                        dialog.dismiss();
                        recreate();
                      } catch (Exception e) {
                        name.setError(e.getMessage());
                      }
                    }));
    dialog.show();
  }

  void persona() {
    LinearLayout box = new LinearLayout(this);
    box.setOrientation(LinearLayout.VERTICAL);
    EditText name = add(box, "你的角色名"), description = add(box, "你的角色背景");
    name.setText(getSharedPreferences("tavern", 0).getString("name", ""));
    description.setText(getSharedPreferences("tavern", 0).getString("description", ""));
    new AlertDialog.Builder(this)
        .setTitle("扮演身份")
        .setView(box)
        .setPositiveButton(
            "保存",
            (d, w) ->
                getSharedPreferences("tavern", 0)
                    .edit()
                    .putString("name", name.getText().toString())
                    .putString("description", description.getText().toString())
                    .apply())
        .setNegativeButton("取消", null)
        .show();
  }

  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request == 22 && result == RESULT_OK && data != null && exportCard != null) {
      android.net.Uri uri = data.getData();
      String json = exportCard;
      work(
          () -> {
            try (OutputStream out = getContentResolver().openOutputStream(uri)) {
              out.write(json.getBytes(StandardCharsets.UTF_8));
            }
            runOnUiThread(() -> feedback.setText("角色卡已导出"));
          });
      return;
    }
    if (request == 21 && result == RESULT_OK && data != null) {
      android.net.Uri uri = data.getData();
      work(
          () -> {
            try (InputStream in = getContentResolver().openInputStream(uri);
                ByteArrayOutputStream out = new ByteArrayOutputStream()) {
              byte[] buf = new byte[8192];
              int n;
              while ((n = in.read(buf)) != -1) {
                if (out.size() + n > 4 * 1024 * 1024) throw new Exception("角色卡最多 4 MB");
                out.write(buf, 0, n);
              }
              new MobileData(this).importCard(out.toByteArray());
              runOnUiThread(this::recreate);
            }
          });
    }
  }
}
