package io.amadeus.mobile;

import android.app.*;
import android.os.*;
import android.widget.*;
import org.json.*;

public class MobileExtensionsActivity extends MobileScreen {
  public void onCreate(Bundle b) {
    super.onCreate(b);
    heading("能力与记忆", "手机独立连接，无需电脑在线。");
    button(
        "模型与供应商", () -> startActivity(new android.content.Intent(this, ModelSetupActivity.class)));
    text("MCP 服务", 22, fg);
    text("支持 HTTPS Streamable HTTP（2025-11-25），令牌加密保存在手机。调用工具前仍需确认；暂不支持 OAuth 和本地进程。", 14, muted);
    button("＋ 连接 MCP 服务", this::addServer);
    try {
      RemoteMcp m = new RemoteMcp(this);
      JSONArray servers = m.servers();
      for (int i = 0; i < servers.length(); i++) {
        JSONObject s = servers.getJSONObject(i);
        button(
            s.optString("name"),
            () ->
                new AlertDialog.Builder(this)
                    .setTitle(s.optString("name"))
                    .setMessage(s.optString("url"))
                    .setPositiveButton(
                        "测试连接",
                        (d, w) -> {
                          feedback.setText("正在获取工具列表…");
                          work(
                              () -> {
                                JSONObject r =
                                    m.call(s.getString("id"), "tools/list", new JSONObject());
                                runOnUiThread(
                                    () ->
                                        feedback.setText(
                                            "已连接 · " + r.optJSONArray("tools").length() + " 个工具"));
                              });
                        })
                    .setNeutralButton(
                        "移除",
                        (d, w) -> {
                          getSharedPreferences("phone-mcp", 0)
                              .edit()
                              .remove(s.optString("id"))
                              .apply();
                          recreate();
                        })
                    .setNegativeButton("取消", null)
                    .show());
      }
    } catch (Exception e) {
      feedback.setText(e.getMessage());
    }
    text("长期记忆", 22, fg);
    Switch enabled = new Switch(this);
    enabled.setText("允许保存和使用长期记忆");
    enabled.setChecked(getSharedPreferences("local-model", 0).getBoolean("automaticMemory", true));
    content.addView(enabled);
    enabled.setOnCheckedChangeListener(
        (v, on) ->
            getSharedPreferences("local-model", 0)
                .edit()
                .putBoolean("automaticMemory", on)
                .apply());
    text("普通聊天、项目和角色分别隔离。只展示当前手机对话范围的记忆。", 14, muted);
    String id = getIntent().getStringExtra("conversationId");
    if (id != null && !id.isEmpty())
      work(
          () -> {
            JSONObject chat = new LocalChat(this).read(id);
            MobileData data = new MobileData(this);
            JSONArray items = data.memories(chat);
            runOnUiThread(
                () -> {
                  if (items.length() == 0) text("此对话范围暂无记忆", 14, muted);
                  for (int i = 0; i < items.length(); i++) {
                    JSONObject item = items.optJSONObject(i);
                    button(
                        item.optString("content"),
                        () ->
                            new AlertDialog.Builder(this)
                                .setTitle("删除这条记忆？")
                                .setMessage(item.optString("content"))
                                .setPositiveButton(
                                    "删除",
                                    (d, w) ->
                                        work(
                                            () -> {
                                              data.memory(
                                                  chat,
                                                  "memory.forget",
                                                  new JSONObject().put("id", item.getString("id")));
                                              runOnUiThread(this::recreate);
                                            }))
                                .setNegativeButton("取消", null)
                                .show());
                  }
                });
          });
  }

  void addServer() {
    LinearLayout box = new LinearLayout(this);
    box.setOrientation(LinearLayout.VERTICAL);
    EditText name = new EditText(this), url = new EditText(this), token = new EditText(this);
    name.setHint("服务名称");
    url.setHint("https://…/mcp");
    token.setHint("访问令牌（可选）");
    token.setInputType(129);
    box.addView(name);
    box.addView(url);
    box.addView(token);
    AlertDialog dialog =
        new AlertDialog.Builder(this)
            .setTitle("连接 MCP")
            .setView(box)
            .setPositiveButton("保存", null)
            .setNegativeButton("取消", null)
            .create();
    dialog.setOnShowListener(
        v ->
            dialog
                .getButton(-1)
                .setOnClickListener(
                    vv -> {
                      String n = name.getText().toString(),
                          u = url.getText().toString(),
                          t = token.getText().toString();
                      work(
                          () -> {
                            new RemoteMcp(this).save(n, u, t);
                            runOnUiThread(
                                () -> {
                                  dialog.dismiss();
                                  recreate();
                                });
                          });
                    }));
    dialog.show();
  }
}
