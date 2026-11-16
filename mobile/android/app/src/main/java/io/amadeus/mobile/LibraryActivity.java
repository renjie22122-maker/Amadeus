package io.amadeus.mobile;

import android.app.*;
import android.content.Intent;
import android.os.Bundle;
import android.widget.*;
import java.util.UUID;
import org.json.*;

/** Local notebooks, project briefs and reusable assistant instructions. */
public class LibraryActivity extends Activity {
  LinearLayout list;
  String collection;

  @Override
  public void onCreate(Bundle state) {
    if ((getResources().getConfiguration().uiMode
            & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
        == android.content.res.Configuration.UI_MODE_NIGHT_YES)
      setTheme(android.R.style.Theme_Material_NoActionBar);
    super.onCreate(state);
    collection = getIntent().getStringExtra("collection");
    if (collection == null) collection = "notes";
    ScrollView scroll = new ScrollView(this);
    list = new LinearLayout(this);
    list.setOrientation(LinearLayout.VERTICAL);
    list.setPadding(32, 64, 32, 40);
    scroll.addView(list);
    setContentView(scroll);
    render();
  }

  String title() {
    return collection.equals("projects")
        ? "手机项目"
        : collection.equals("assistants") ? "自定义助手" : "笔记与资料库";
  }

  void button(String name, Runnable action) {
    Button b = new Button(this);
    b.setText(name);
    b.setOnClickListener(v -> action.run());
    list.addView(b);
  }

  void render() {
    list.removeAllViews();
    TextView title = new TextView(this);
    title.setText(title());
    title.setTextSize(26);
    list.addView(title);
    TextView hint = new TextView(this);
    hint.setText(
        collection.equals("projects") ? "项目对话和说明保存在手机；这里不是本地编译环境。" : "保存在本机。可以编辑、删除，或带入独立聊天。");
    list.addView(hint);
    button("新建", () -> edit(null));
    for (String id : getSharedPreferences("library-" + collection, 0).getAll().keySet()) {
      try {
        JSONObject item =
            new JSONObject(getSharedPreferences("library-" + collection, 0).getString(id, "{}"));
        button(item.optString("name"), () -> edit(id));
      } catch (Exception ignored) {
      }
    }
    button("返回聊天", this::finish);
  }

  void edit(String id) {
    try {
      JSONObject item =
          id == null
              ? new JSONObject()
              : new JSONObject(
                  getSharedPreferences("library-" + collection, 0).getString(id, "{}"));
      LinearLayout form = new LinearLayout(this);
      form.setOrientation(LinearLayout.VERTICAL);
      form.setPadding(24, 0, 24, 0);
      EditText name = new EditText(this);
      name.setHint("名称");
      name.setText(item.optString("name"));
      form.addView(name);
      EditText text = new EditText(this);
      text.setHint(collection.equals("projects") ? "项目说明与上下文" : "内容或助手指令");
      text.setMinLines(4);
      text.setText(item.optString("text"));
      form.addView(text);
      String key = id == null ? UUID.randomUUID().toString() : id;
      AlertDialog dialog =
          new AlertDialog.Builder(this)
              .setTitle(title())
              .setView(form)
              .setNegativeButton("取消", null)
              .setPositiveButton(
                  "保存",
                  (d, w) -> {
                    try {
                      if (name.getText().toString().trim().isEmpty()) return;
                      getSharedPreferences("library-" + collection, 0)
                          .edit()
                          .putString(
                              key,
                              new JSONObject()
                                  .put("id", key)
                                  .put("name", name.getText().toString())
                                  .put("text", text.getText().toString())
                                  .toString())
                          .apply();
                      render();
                    } catch (Exception ignored) {
                    }
                  })
              .setNeutralButton(
                  id == null ? "关闭" : "更多",
                  (d, w) -> {
                    if (id == null) return;
                    new AlertDialog.Builder(this)
                        .setItems(
                            new String[] {"带入手机聊天", "删除"},
                            (a, which) -> {
                              if (which == 0) {
                                startActivity(
                                    new Intent(this, MainActivity.class)
                                        .addFlags(
                                            Intent.FLAG_ACTIVITY_CLEAR_TOP
                                                | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                                        .putExtra("localDraft", item.optString("text"))
                                        .putExtra(
                                            "localProject",
                                            collection.equals("projects") ? id : ""));
                                finish();
                              } else
                                new AlertDialog.Builder(this)
                                    .setMessage("删除此条目？已有聊天记录会保留。")
                                    .setNegativeButton("取消", null)
                                    .setPositiveButton(
                                        "删除",
                                        (x, y) -> {
                                          getSharedPreferences("library-" + collection, 0)
                                              .edit()
                                              .remove(id)
                                              .apply();
                                          render();
                                        })
                                    .show();
                            })
                        .show();
                  })
              .create();
      dialog.show();
    } catch (Exception e) {
      Toast.makeText(this, "无法读取内容", Toast.LENGTH_SHORT).show();
    }
  }
}
