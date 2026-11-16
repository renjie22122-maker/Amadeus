package io.amadeus.mobile;

import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.view.View;
import android.widget.*;
import java.util.UUID;
import java.util.concurrent.Executors;
import org.json.*;

public class SettingsActivity extends Activity {
  final java.util.concurrent.ExecutorService network = Executors.newSingleThreadExecutor();
  LinearLayout column, rootColumn, categories;
  final java.util.LinkedHashMap<String, LinearLayout> pages = new java.util.LinkedHashMap<>();
  TextView pageTitle, back;
  int foreground, background, card, secondary;

  void section(String name) {
    if (!pages.containsKey(name)) {
      LinearLayout page = new LinearLayout(this);
      page.setOrientation(LinearLayout.VERTICAL);
      rootColumn.addView(page);
      pages.put(name, page);
      TextView entry = ChatUi.label(this, name + "  ›", 17, foreground);
      entry.setPadding(24, 28, 24, 28);
      entry.setBackground(ChatUi.rounded(card, 20, this));
      LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
      lp.setMargins(0, 0, 0, 16);
      categories.addView(entry, lp);
      entry.setOnClickListener(v -> showPage(name));
    }
    column = pages.get(name);
  }

  void showPage(String name) {
    categories.setVisibility(name == null ? View.VISIBLE : View.GONE);
    for (var entry : pages.entrySet())
      entry.getValue().setVisibility(entry.getKey().equals(name) ? View.VISIBLE : View.GONE);
    pageTitle.setText(name == null ? "工具与设置" : name);
    back.setText(name == null ? "‹ 返回聊天" : "‹ 所有设置");
    back.setOnClickListener(
        v -> {
          if (name == null) finish();
          else showPage(null);
        });
  }

  TextView status, transcript;
  EditText message;
  final Handler handler = new Handler(Looper.getMainLooper());
  boolean visible;

  interface Work {
    void run() throws Exception;
  }

  void work(Work job) {
    network.execute(
        () -> {
          try {
            job.run();
          } catch (Exception e) {
            runOnUiThread(() -> status.setText(e.getMessage()));
          }
        });
  }

  TextView text(String s) {
    TextView v = new TextView(this);
    v.setText(s);
    v.setTextSize(16);
    v.setTextColor(foreground);
    v.setPadding(0, 12, 0, 12);
    column.addView(v);
    return v;
  }

  EditText input(String hint) {
    EditText v = new EditText(this);
    v.setHint(hint);
    v.setTextColor(foreground);
    v.setHintTextColor(secondary);
    v.setPadding(24, 24, 24, 24);
    column.addView(v);
    return v;
  }

  void button(String label, Runnable fn) {
    TextView b = ChatUi.label(this, label + "  ›", 16, foreground);
    b.setPadding(24, 28, 24, 28);
    b.setBackground(ChatUi.rounded(card, 18, this));
    b.setOnClickListener(v -> fn.run());
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
    lp.setMargins(0, 8, 0, 8);
    column.addView(b, lp);
  }

  @Override
  public void onCreate(Bundle state) {
    if ((getResources().getConfiguration().uiMode
            & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
        == android.content.res.Configuration.UI_MODE_NIGHT_YES)
      setTheme(android.R.style.Theme_Material_NoActionBar);
    super.onCreate(state);
    boolean dark =
        (getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
            == android.content.res.Configuration.UI_MODE_NIGHT_YES;
    foreground = dark ? 0xffe8eaed : 0xff202124;
    background = dark ? 0xff131314 : 0xfff9f9fc;
    card = dark ? 0xff26272a : 0xffe9edf5;
    secondary = dark ? 0xffa6abb7 : 0xff717680;
    ScrollView scroll = new ScrollView(this);
    scroll.setBackgroundColor(background);
    column = new LinearLayout(this);
    column.setOrientation(LinearLayout.VERTICAL);
    column.setPadding(28, 56, 28, 32);
    scroll.addView(column);
    setContentView(scroll);
    rootColumn = column;
    back = text("‹ 返回聊天");
    back.setTextColor(secondary);
    pageTitle = text("工具与设置");
    pageTitle.setTextSize(28);
    status =
        text(
            getSharedPreferences("pair", 0).contains("token")
                ? "已配对 · 无需再次输入配对码"
                : "尚未配对 · 先连接你的电脑");
    categories = new LinearLayout(this);
    categories.setOrientation(LinearLayout.VERTICAL);
    rootColumn.addView(categories);
    section("设备与连接");
    text("已配对的电脑无需重复输入配对码。切换电脑请使用聊天侧栏的设备入口。");
    EditText url = input("电脑连接入口：https://your-domain");
    url.setSingleLine(true);
    url.setText(getSharedPreferences("pair", 0).getString("url", ""));
    EditText code = input("电脑上生成的五分钟配对码");
    code.setSingleLine(true);
    code.setInputType(129);
    button(
        "配对电脑",
        () -> {
          if (code.getText().toString().trim().isEmpty()) {
            status.setText(
                getSharedPreferences("pair", 0).contains("token")
                    ? "已经配对，请返回聊天。更换电脑时才需要新的配对码。"
                    : "请输入电脑生成的配对码");
            return;
          }
          stopService(new Intent(this, DotService.class));
          String address = url.getText().toString(), secret = code.getText().toString().trim();
          work(
              () -> {
                JSONObject result =
                    AgentClient.request(
                        address, "/v1/pair", new JSONObject().put("code", secret), null);
                new AgentClient(this).save(address, result.getString("token"));
                AgentClient.commandPreferences(this).edit().clear().commit();
                getSharedPreferences("outbox", 0).edit().clear().commit();
                runOnUiThread(
                    () -> {
                      code.setText("");
                      status.setText("已配对。手机和电脑现在使用同一个助手。");
                    });
                refresh();
              });
        });
    section("常驻助手");
    button(
        "启动常驻连接与悬浮入口",
        () -> {
          if (Build.VERSION.SDK_INT >= 33
              && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                  != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {"android.permission.POST_NOTIFICATIONS"}, 71);
            return;
          }
          startForegroundService(new Intent(this, DotService.class));
          status.setText("连接已启动；通知栏可随时停止。电脑必须保持运行。");
        });
    button(
        "停止手机常驻连接",
        () -> {
          stopService(new Intent(this, DotService.class));
          status.setText("手机操作会话已停止；电脑上的目标不会因此取消。");
        });
    button(
        "悬浮入口权限",
        () ->
            startActivity(
                new Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getPackageName()))));
    section("隐私与权限");
    button(
        "屏幕操作权限说明",
        () ->
            new AlertDialog.Builder(this)
                .setTitle("允许屏幕操作？")
                .setMessage(
                    "启用无障碍服务后，仅在你启动常驻连接期间，配对的 Agent"
                        + " 经审批可以读取屏幕、点击与滑动。可能看到屏幕上的私人信息。关闭连接或关闭无障碍服务即停止。请只在自己的设备使用。")
                .setNegativeButton("取消", null)
                .setPositiveButton(
                    "打开系统设置",
                    (d, w) -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)))
                .show());
    button(
        "允许读取选定照片",
        () ->
            requestPermissions(
                Build.VERSION.SDK_INT >= 34
                    ? new String[] {
                      "android.permission.READ_MEDIA_IMAGES",
                      "android.permission.READ_MEDIA_VISUAL_USER_SELECTED"
                    }
                    : Build.VERSION.SDK_INT >= 33
                        ? new String[] {"android.permission.READ_MEDIA_IMAGES"}
                        : new String[] {"android.permission.READ_EXTERNAL_STORAGE"},
                2));
    button(
        "短信 / 通话记录权限（系统可能限制）",
        () ->
            new AlertDialog.Builder(this)
                .setMessage("仅在 Android 与安装来源允许时读取。不能绕过系统限制；不会自动发送、删除短信或开启通话录音。")
                .setNegativeButton("取消", null)
                .setPositiveButton(
                    "申请读取",
                    (d, w) ->
                        requestPermissions(
                            new String[] {
                              "android.permission.READ_SMS", "android.permission.READ_CALL_LOG"
                            },
                            4))
                .show());
    button(
        "联系人读取权限", () -> requestPermissions(new String[] {"android.permission.READ_CONTACTS"}, 5));
    section("文件与相册");
    button(
        "选择录音或文件整理目录",
        () ->
            startActivityForResult(
                new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
                    .addFlags(
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION),
                10));
    button(
        "选择文件发给 Agent 分析（含邮件导出、录音、照片）",
        () ->
            startActivityForResult(
                new Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .setType("*/*")
                    .addCategory(Intent.CATEGORY_OPENABLE),
                11));
    section("录音与音频");
    button(
        "开始麦克风录音",
        () -> {
          if (checkSelfPermission("android.permission.RECORD_AUDIO")
              != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {"android.permission.RECORD_AUDIO"}, 6);
            return;
          }
          if (Build.VERSION.SDK_INT >= 33
              && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                  != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {"android.permission.POST_NOTIFICATIONS"}, 1);
            return;
          }
          startForegroundService(new Intent(this, RecordingService.class));
          status.setText("麦克风录音已启动；这不是系统通话录音。通知栏可停止。");
        });
    button("停止录音", () -> stopService(new Intent(this, RecordingService.class)));
    button(
        "发送本机录音分析",
        () -> {
          java.io.File[] files =
              new java.io.File(getExternalFilesDir(null), "recordings").listFiles();
          if (files == null || files.length == 0) {
            status.setText("暂无录音");
            return;
          }
          String[] names = new String[files.length];
          for (int i = 0; i < files.length; i++) names[i] = files[i].getName();
          new AlertDialog.Builder(this)
              .setTitle("选择已停止的录音上传到配对电脑")
              .setItems(
                  names,
                  (d, index) ->
                      work(
                          () -> {
                            try (var input = new java.io.FileInputStream(files[index])) {
                              uploadFile(names[index], input);
                            }
                          }))
              .show();
        });
    section("连接的服务");
    button(
        "邮件整理连接说明",
        () ->
            new AlertDialog.Builder(this)
                .setTitle("邮件整理")
                .setMessage(
                    "在电脑的插件设置中连接你自己的邮箱 MCP 服务，授权读信、分类或归档。手机可直接给同一个 Agent 下达整理请求。此应用不会读取手机邮箱 App"
                        + " 的私有数据库，也不会假装已连接邮箱。也可选择导出的邮件文件上传分析。")
                .setPositiveButton("知道了", null)
                .show());
    section("目标与审批");
    message = new EditText(this);
    transcript = new TextView(this);
    button("返回聊天", () -> finish());
    button("新增长期目标", this::goalDialog);
    button(
        "管理长期目标",
        () ->
            work(
                () -> {
                  JSONArray goals =
                      new AgentClient(this).call("/v1/state", null).getJSONArray("goals");
                  String[] names = new String[goals.length()];
                  for (int i = 0; i < goals.length(); i++)
                    names[i] = goals.getJSONObject(i).getString("title");
                  runOnUiThread(
                      () ->
                          new AlertDialog.Builder(this)
                              .setTitle("选择目标")
                              .setItems(
                                  names,
                                  (d, index) -> {
                                    try {
                                      String key = goals.getJSONObject(index).getString("id");
                                      new AlertDialog.Builder(this)
                                          .setTitle(names[index])
                                          .setItems(
                                              new String[] {"暂停后续执行", "恢复", "现在检查"},
                                              (dialog, action) ->
                                                  work(
                                                      () -> {
                                                        new AgentClient(this)
                                                            .call(
                                                                "/v1/goals/" + key + "/action",
                                                                new JSONObject()
                                                                    .put(
                                                                        "action",
                                                                        new String[] {
                                                                              "pause", "resume",
                                                                              "wake"
                                                                            }
                                                                            [action])
                                                                    .put(
                                                                        "eventId",
                                                                        UUID.randomUUID()
                                                                            .toString()));
                                                        refresh();
                                                      }))
                                          .show();
                                    } catch (Exception e) {
                                      status.setText(e.getMessage());
                                    }
                                  })
                              .setNegativeButton("关闭", null)
                              .show());
                }));
    section("手机工具");
    button("查看本机待办", this::todos);
    section("文件与相册");
    button(
        "查看智能相册分类",
        () -> {
          var albums = getSharedPreferences("albums", 0).getAll();
          String[] names = albums.keySet().toArray(new String[0]);
          new AlertDialog.Builder(this)
              .setTitle(names.length == 0 ? "还没有相册分类" : "相册分类 · 原图不移动")
              .setItems(
                  names,
                  (d, w) -> {
                    try {
                      JSONArray ids = new JSONArray(String.valueOf(albums.get(names[w])));
                      new AlertDialog.Builder(this)
                          .setTitle(names[w])
                          .setMessage("包含 " + ids.length() + " 张照片，分类信息保存在本机。")
                          .setPositiveButton("关闭", null)
                          .show();
                    } catch (Exception ignored) {
                    }
                  })
              .setNegativeButton("关闭", null)
              .show();
        });
    section("目标与审批");
    button(
        "处理待审批请求",
        () ->
            work(
                () -> {
                  JSONObject s = new AgentClient(this).call("/v1/state", null);
                  JSONArray inputs = s.optJSONArray("inputs");
                  if (inputs == null || inputs.length() == 0) {
                    runOnUiThread(() -> status.setText("没有待审批请求，或设备未获审批权限。"));
                    return;
                  }
                  JSONObject q = inputs.getJSONObject(0);
                  runOnUiThread(() -> approvalDialog(q));
                }));
    section("设备与连接");
    button(
        "断开并清除本机配对",
        () -> {
          stopService(new Intent(this, DotService.class));
          getSharedPreferences("pair", 0).edit().clear().commit();
          getSharedPreferences("outbox", 0).edit().clear().commit();
          status.setText("本机已断开。请在电脑撤销设备凭证。");
        });
    section("手机工具");
    button(
        "设置闹钟",
        () -> {
          java.util.Calendar now = java.util.Calendar.getInstance();
          new TimePickerDialog(
                  this,
                  (v, h, m) -> {
                    try {
                      PhoneActions.run(
                          this,
                          new JSONObject()
                              .put("capability", "alarm.create")
                              .put("args", new JSONObject().put("hour", h).put("minute", m))
                              .put("expiresAt", System.currentTimeMillis() + 60000));
                    } catch (Exception e) {
                      status.setText(e.getMessage());
                    }
                  },
                  now.get(java.util.Calendar.HOUR_OF_DAY),
                  now.get(java.util.Calendar.MINUTE),
                  true)
              .show();
        });
    button(
        "开始计时器",
        () -> {
          EditText seconds = new EditText(this);
          seconds.setHint("秒数，例如 300");
          seconds.setInputType(2);
          new AlertDialog.Builder(this)
              .setTitle("计时器")
              .setView(seconds)
              .setNegativeButton("取消", null)
              .setPositiveButton(
                  "打开系统计时器",
                  (d, w) -> {
                    try {
                      PhoneActions.run(
                          this,
                          new JSONObject()
                              .put("capability", "timer.create")
                              .put(
                                  "args",
                                  new JSONObject()
                                      .put(
                                          "seconds",
                                          Integer.parseInt(seconds.getText().toString())))
                              .put("expiresAt", System.currentTimeMillis() + 60000));
                    } catch (Exception e) {
                      status.setText("请输入 1–86400 秒");
                    }
                  })
              .show();
        });
    showPage(null);
    handleCommand(getIntent());
    if (getIntent().getBooleanExtra("pickFile", false))
      startActivityForResult(
          new Intent(Intent.ACTION_OPEN_DOCUMENT)
              .setType(getIntent().getBooleanExtra("photos", false) ? "image/*" : "*/*")
              .addCategory(Intent.CATEGORY_OPENABLE),
          11);
  }

  void todos() {
    try {
      JSONArray items = new JSONArray(getSharedPreferences("todos", 0).getString("items", "[]"));
      String[] names = new String[items.length()];
      boolean[] done = new boolean[items.length()];
      for (int i = 0; i < names.length; i++) {
        names[i] = items.getJSONObject(i).optString("title");
        done[i] = items.getJSONObject(i).optBoolean("done");
      }
      new AlertDialog.Builder(this)
          .setTitle("本机待办")
          .setMultiChoiceItems(
              names,
              done,
              (d, which, checked) -> {
                try {
                  items.getJSONObject(which).put("done", checked);
                  getSharedPreferences("todos", 0)
                      .edit()
                      .putString("items", items.toString())
                      .apply();
                } catch (Exception ignored) {
                }
              })
          .setPositiveButton("完成", null)
          .setNeutralButton(
              "新增",
              (d, w) -> {
                EditText title = new EditText(this);
                title.setHint("要做什么？");
                new AlertDialog.Builder(this)
                    .setTitle("新增待办")
                    .setView(title)
                    .setNegativeButton("取消", null)
                    .setPositiveButton(
                        "保存",
                        (x, y) -> {
                          try {
                            PhoneActions.run(
                                this,
                                new JSONObject()
                                    .put("id", UUID.randomUUID().toString())
                                    .put("capability", "todo.create")
                                    .put(
                                        "args",
                                        new JSONObject().put("title", title.getText().toString()))
                                    .put("expiresAt", System.currentTimeMillis() + 60000));
                            todos();
                          } catch (Exception e) {
                            status.setText("请填写待办内容");
                          }
                        })
                    .show();
              })
          .show();
    } catch (Exception e) {
      status.setText("无法读取本机待办");
    }
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    handleCommand(intent);
  }

  @Override
  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (result != RESULT_OK || data == null || data.getData() == null) return;
    Uri uri = data.getData();
    if (request == 10) {
      try {
        getContentResolver()
            .takePersistableUriPermission(
                uri,
                (data.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0
                    ? Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    : Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getSharedPreferences("files", 0).edit().putString("tree", uri.toString()).commit();
        status.setText("已授权此目录；重命名需要本机确认。");
      } catch (Exception e) {
        status.setText(e.getMessage());
      }
    } else if (request == 11)
      work(
          () -> {
            String name = "attachment.bin";
            try (var cursor =
                getContentResolver().query(uri, new String[] {"_display_name"}, null, null, null)) {
              if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
            }
            try (var input = getContentResolver().openInputStream(uri)) {
              uploadFile(name, input);
            }
          });
  }

  void uploadFile(String name, java.io.InputStream input) throws Exception {
    if (input == null) throw new Exception("Cannot read file");
    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
    byte[] chunk = new byte[8192];
    int n;
    while ((n = input.read(chunk)) != -1) {
      if (out.size() + n > 6 * 1024 * 1024) throw new Exception("手机上传上限6MB，请分段录音或在电脑导入较大文件。");
      out.write(chunk, 0, n);
    }
    JSONObject attachment =
        new AgentClient(this)
            .call(
                "/v1/attachments",
                new JSONObject()
                    .put("conversationId", getIntent().getStringExtra("conversationId"))
                    .put("name", name.replaceAll("[\\r\\n\"\\\\/]", "_"))
                    .put(
                        "base64",
                        android.util.Base64.encodeToString(
                            out.toByteArray(), android.util.Base64.NO_WRAP)));
    String target = getIntent().getStringExtra("conversationId");
    if (target == null || target.isEmpty())
      target =
          new AgentClient(this)
              .call("/v1/state", null)
              .getJSONObject("identity")
              .getString("conversationId");
    var files = getSharedPreferences("chat-attachments", 0);
    JSONArray selected = new JSONArray(files.getString(target, "[]"));
    if (selected.length() >= 4) throw new Exception("每条消息最多4个附件；文件已上传，可在电脑会话中查看。");
    selected.put(new JSONObject().put("id", attachment.getString("id")).put("name", name));
    files.edit().putString(target, selected.toString()).commit();
    runOnUiThread(
        () -> {
          Toast.makeText(this, "附件已添加，返回聊天后可以输入问题", Toast.LENGTH_SHORT).show();
          finish();
        });
  }

  void handleCommand(Intent intent) {
    String key = intent.getStringExtra("commandId");
    if (key == null) return;
    String raw = AgentClient.commandPreferences(this).getString("pending:" + key, null);
    if (raw == null) return;
    try {
      JSONObject command = new JSONObject(raw);
      new AlertDialog.Builder(this)
          .setTitle("手机操作请求")
          .setMessage(
              command.getString("capability") + "\n" + command.getJSONObject("args").toString(2))
          .setNegativeButton(
              "拒绝", (d, w) -> DotService.finish(this, key, "failed", "User declined"))
          .setPositiveButton(
              "执行",
              (d, w) -> {
                work(
                    () -> {
                      new AgentClient(this).call("/v1/state", null);
                      runOnUiThread(
                          () -> {
                            if (!DotService.active
                                || !AgentClient.commandPreferences(this)
                                    .contains("pending:" + key)) {
                              status.setText("控制会话已停止，请勿重复执行旧请求。");
                              return;
                            }
                            AgentClient.commandPreferences(this)
                                .edit()
                                .remove("pending:" + key)
                                .commit();
                            try {
                              Object result = PhoneActions.run(this, command);
                              DotService.finish(this, key, "completed", result);
                            } catch (Exception e) {
                              DotService.finish(this, key, "unknown", e.getMessage());
                            }
                          });
                    });
              })
          .show();
    } catch (Exception e) {
      status.setText(e.getMessage());
    }
  }

  void approvalDialog(JSONObject q) {
    EditText answer = new EditText(this);
    answer.setHint("补充回答（可选）");
    new AlertDialog.Builder(this)
        .setTitle("Agent 请求确认")
        .setMessage(q.toString())
        .setView(answer)
        .setNegativeButton("拒绝", (d, w) -> respond(q, false, answer.getText().toString()))
        .setPositiveButton("允许 / 回答", (d, w) -> respond(q, true, answer.getText().toString()))
        .show();
  }

  void respond(JSONObject q, boolean allow, String answer) {
    work(
        () -> {
          new AgentClient(this)
              .call(
                  "/v1/input",
                  new JSONObject()
                      .put("id", q.getString("id"))
                      .put("allow", allow)
                      .put("answer", answer));
          refresh();
        });
  }

  void goalDialog() {
    LinearLayout form = new LinearLayout(this);
    form.setOrientation(LinearLayout.VERTICAL);
    EditText objective = new EditText(this), success = new EditText(this);
    objective.setHint("目标");
    success.setHint("完成标准");
    form.addView(objective);
    form.addView(success);
    new AlertDialog.Builder(this)
        .setTitle("长期目标：每30分钟，最多24轮，24小时截止")
        .setView(form)
        .setNegativeButton("取消", null)
        .setPositiveButton(
            "启动",
            (d, w) -> {
              String o = objective.getText().toString(), s = success.getText().toString();
              work(
                  () -> {
                    new AgentClient(this)
                        .call(
                            "/v1/goals",
                            new JSONObject()
                                .put("title", o.substring(0, Math.min(100, o.length())))
                                .put("objective", o)
                                .put("success", s)
                                .put("intervalMs", 1800000)
                                .put("maxRuns", 24)
                                .put("endAt", System.currentTimeMillis() + 86400000));
                    refresh();
                  });
            })
        .show();
  }

  void refresh() {
    work(
        () -> {
          JSONObject s = new AgentClient(this).call("/v1/state", null);
          StringBuilder display = new StringBuilder();
          JSONArray goals = s.optJSONArray("goals");
          if (goals != null)
            for (int i = 0; i < goals.length(); i++) {
              JSONObject g = goals.getJSONObject(i);
              display
                  .append("◎ ")
                  .append(g.optString("title"))
                  .append(" · ")
                  .append(g.optJSONObject("task").optString("status"))
                  .append("\n");
            }
          JSONArray events = s.optJSONArray("events");
          if (events != null)
            for (int i = 0; i < events.length(); i++) {
              JSONObject e = events.getJSONObject(i);
              JSONObject data = e.optJSONObject("data");
              if (data != null && data.has("text"))
                display
                    .append(e.optString("type").startsWith("user") ? "你：" : "Amadeus：")
                    .append(data.optString("text"))
                    .append("\n\n");
            }
          runOnUiThread(() -> transcript.setText(display.toString()));
        });
  }

  final Runnable poll =
      new Runnable() {
        public void run() {
          if (visible) {
            refresh();
            handler.postDelayed(this, 10000);
          }
        }
      };

  @Override
  public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
    super.onRequestPermissionsResult(request, permissions, grants);
    if (request == 71 && grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED) {
      startForegroundService(new Intent(this, DotService.class));
      status.setText("常驻连接已启动；悬浮入口需要单独允许悬浮权限。");
    }
  }

  @Override
  protected void onResume() {
    super.onResume();
    visible = true;
    status.setText(
        (getSharedPreferences("pair", 0).contains("token") ? "电脑已配对" : "未连接电脑 · 本机工具仍可使用")
            + " · "
            + (DotService.active ? "常驻已启动" : "常驻未启动")
            + "\n悬浮入口："
            + (Settings.canDrawOverlays(this) ? "已授权" : "未授权"));
    if (getIntent().getBooleanExtra("newGoal", false)) {
      getIntent().removeExtra("newGoal");
      goalDialog();
    }
  }

  @Override
  protected void onPause() {
    visible = false;
    handler.removeCallbacks(poll);
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    network.shutdownNow();
    super.onDestroy();
  }
}
