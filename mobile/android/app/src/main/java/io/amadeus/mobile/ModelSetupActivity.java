package io.amadeus.mobile;

import android.app.AlertDialog;
import android.os.Bundle;
import android.view.*;
import android.widget.*;
import org.json.*;

public class ModelSetupActivity extends MobileScreen {
  @Override
  public void onCreate(Bundle saved) {
    super.onCreate(saved);
    heading("连接你的模型", "选择供应商，输入密钥，再从服务返回的列表中选择模型。");
    LocalChat local = new LocalChat(this);
    try {
      JSONObject cfg = local.config();
      String[] names = {"DeepSeek", "Google Gemini", "OpenAI", "自定义兼容服务"};
      String[] addresses = {
        "https://api.deepseek.com",
        "https://generativelanguage.googleapis.com/v1beta/openai",
        "https://api.openai.com/v1",
        ""
      };
      Spinner providers = new Spinner(this);
      providers.setAdapter(
          new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, names));
      content.addView(providers);
      int selected = 3;
      for (int i = 0; i < 3; i++) if (addresses[i].equals(cfg.optString("base"))) selected = i;
      EditText base = field("HTTPS API 地址", cfg.optString("base")),
          key = field("API 密钥 · 留空保留当前连接密钥", ""),
          model = field("选择或输入模型名称", cfg.optString("model"));
      key.setInputType(129);
      base.setSingleLine(true);
      model.setSingleLine(true);
      providers.setSelection(selected);
      final int[] previous = {selected};
      providers.setOnItemSelectedListener(
          new android.widget.AdapterView.OnItemSelectedListener() {
            public void onNothingSelected(android.widget.AdapterView<?> p) {}

            public void onItemSelected(
                android.widget.AdapterView<?> p, View v, int position, long id) {
              if (previous[0] != position) {
                base.setText(addresses[position]);
                key.setText("");
                model.setText("");
                previous[0] = position;
              }
              base.setVisibility(position == 3 ? View.VISIBLE : View.GONE);
            }
          });
      TextView fetch = button("获取可用模型  ↗", () -> {});
      fetch.setOnClickListener(
          v -> {
            String url = base.getText().toString(), secret = key.getText().toString();
            fetch.setEnabled(false);
            feedback.setText("正在读取此账号可用的模型…");
            work(
                () -> {
                  try {
                    JSONArray list = local.discoverModels(url, secret);
                    String[] choices = new String[list.length()];
                    for (int i = 0; i < choices.length; i++) choices[i] = list.getString(i);
                    runOnUiThread(
                        () -> {
                          if (isDestroyed()) return;
                          feedback.setText(choices.length + " 个模型 · 请选择支持聊天的模型");
                          new AlertDialog.Builder(this)
                              .setTitle("可用模型")
                              .setItems(choices, (d, w) -> model.setText(choices[w]))
                              .setNegativeButton("取消", null)
                              .show();
                        });
                  } finally {
                    runOnUiThread(() -> fetch.setEnabled(true));
                  }
                });
          });
      CheckBox tools = new CheckBox(this);
      tools.setText("允许对话调用工具");
      tools.setChecked(cfg.optBoolean("tools", true));
      content.addView(tools);
      CheckBox effort = new CheckBox(this);
      effort.setText("此连接支持标准推理强度参数");
      effort.setChecked(cfg.optBoolean("effort"));
      content.addView(effort);
      button(
          "保存连接",
          () -> {
            String url = base.getText().toString(),
                name = model.getText().toString(),
                secret = key.getText().toString();
            boolean thinking = effort.isChecked(), toolUse = tools.isChecked();
            work(
                () -> {
                  local.configure(url, name, secret, thinking, toolUse);
                  runOnUiThread(
                      () -> {
                        Toast.makeText(this, "模型连接已保存", Toast.LENGTH_SHORT).show();
                        finish();
                      });
                });
          });
      text("模型列表来自供应商，不会将密钥发送到其他连接。自定义服务需提供兼容的聊天接口。", 13, muted);
    } catch (Exception e) {
      feedback.setText("无法读取连接配置");
    }
  }
}
