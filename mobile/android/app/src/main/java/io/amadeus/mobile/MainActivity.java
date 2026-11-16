package io.amadeus.mobile;

import android.app.*;
import android.content.*;
import android.content.res.Configuration;
import android.graphics.Typeface;
import android.os.*;
import android.speech.RecognizerIntent;
import android.speech.tts.TextToSpeech;
import android.text.*;
import android.text.method.LinkMovementMethod;
import android.view.*;
import android.widget.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;

public class MainActivity extends Activity {
  final ExecutorService network = Executors.newSingleThreadExecutor();
  final Handler handler = new Handler(Looper.getMainLooper());
  final AtomicBoolean loading = new AtomicBoolean();
  LinearLayout root, messages, composer;
  ScrollView scroll;
  EditText input;
  TextView title, model, status, attachment;
  TextToSpeech speech;
  JSONObject state = new JSONObject(), index = new JSONObject();
  String conversationId = "", renderKey = "";
  boolean visible;
  volatile boolean sending;
  int bg, fg, muted, surface, accent;

  interface Work {
    void run() throws Exception;
  }

  int dp(float n) {
    return ChatUi.dp(this, n);
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

  TextView label(String value, int size, int color) {
    return ChatUi.label(this, value, size, color);
  }

  LinearLayout vertical() {
    LinearLayout v = new LinearLayout(this);
    v.setOrientation(LinearLayout.VERTICAL);
    return v;
  }

  ChatUi.Icon icon(String type, String description, Runnable action) {
    return new ChatUi.Icon(this, type, description, fg, action);
  }

  @Override
  public void onCreate(Bundle saved) {
    super.onCreate(saved);
    boolean dark =
        (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
            == Configuration.UI_MODE_NIGHT_YES;
    bg = dark ? 0xff15171c : 0xfffbfcff;
    fg = dark ? 0xffe9eaf0 : 0xff202124;
    muted = dark ? 0xffa6abb7 : 0xff717680;
    surface = dark ? 0xff252932 : 0xffeef1f7;
    accent = dark ? 0xffb4c4ff : 0xff4c5ca6;
    getWindow().setStatusBarColor(bg);
    getWindow().setNavigationBarColor(bg);
    if (!dark)
      getWindow()
          .getDecorView()
          .setSystemUiVisibility(
              View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    root = vertical();
    root.setBackgroundColor(bg);
    setContentView(root);
    root.setOnApplyWindowInsetsListener(
        (view, insets) -> {
          android.graphics.Insets system =
              insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
          view.setPadding(system.left, system.top, system.right, system.bottom);
          return insets;
        });
    LinearLayout header = new LinearLayout(this);
    header.setGravity(Gravity.CENTER_VERTICAL);
    header.setPadding(dp(8), dp(6), dp(8), dp(6));
    header.addView(icon("menu", "打开会话侧栏", this::drawer));
    LinearLayout heading = vertical();
    title = label("Amadeus", 21, fg);
    title.setTypeface(null, Typeface.BOLD);
    title.setSingleLine(true);
    title.setEllipsize(TextUtils.TruncateAt.END);
    model = label("连接你的个人助手  ▾", 12, muted);
    heading.addView(title);
    heading.addView(model);
    heading.setPadding(dp(8), 0, 0, 0);
    heading.setOnClickListener(v -> models());
    header.addView(heading, new LinearLayout.LayoutParams(0, dp(50), 1));
    header.addView(icon("plus", "新对话", this::newChat));
    header.addView(icon("dots", "会话菜单", this::chatMenu));
    root.addView(header);
    status = label("", 12, muted);
    status.setPadding(dp(24), 0, dp(24), dp(6));
    root.addView(status);
    scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    scroll.setClipToPadding(false);
    messages = vertical();
    messages.setPadding(dp(20), dp(12), dp(20), dp(20));
    scroll.addView(messages);
    root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
    LinearLayout bottom = vertical();
    bottom.setPadding(dp(12), dp(6), dp(12), dp(10));
    attachment = label("", 12, accent);
    attachment.setPadding(dp(14), dp(4), dp(14), dp(4));
    attachment.setVisibility(View.GONE);
    bottom.addView(attachment);
    composer = vertical();
    composer.setPadding(dp(8), dp(4), dp(8), dp(6));
    composer.setBackground(ChatUi.rounded(surface, 28, this));
    input = new EditText(this);
    input.setHint("问 Amadeus，或描述你想完成的事");
    input.setTextColor(fg);
    input.setHintTextColor(muted);
    input.setTextSize(16);
    input.setBackgroundColor(android.graphics.Color.TRANSPARENT);
    input.setPadding(dp(12), dp(12), dp(12), dp(8));
    input.setMinLines(1);
    input.setMaxLines(6);
    input.setInputType(
        android.text.InputType.TYPE_CLASS_TEXT
            | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
            | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
    composer.addView(input);
    LinearLayout actions = new LinearLayout(this);
    actions.setGravity(Gravity.CENTER_VERTICAL);
    actions.addView(icon("plus", "添加照片或文件", this::attachments));
    actions.addView(icon("tools", "工具与能力", this::tools));
    View spacer = new View(this);
    actions.addView(spacer, new LinearLayout.LayoutParams(0, 1, 1));
    actions.addView(icon("mic", "语音输入", this::dictate));
    ChatUi.Icon send =
        new ChatUi.Icon(this, "send", "发送消息", dark ? 0xff202124 : 0xffffffff, this::send);
    send.setBackground(ChatUi.rounded(accent, 24, this));
    actions.addView(send);
    composer.addView(actions);
    bottom.addView(composer);
    root.addView(bottom);
    conversationId = getSharedPreferences("chat-ui", 0).getString("conversationId", "");
    input.addTextChangedListener(
        new TextWatcher() {
          public void beforeTextChanged(CharSequence s, int a, int c, int f) {}

          public void onTextChanged(CharSequence s, int a, int b, int c) {
            getSharedPreferences("chat-drafts", 0)
                .edit()
                .putString(conversationId, s.toString())
                .apply();
          }

          public void afterTextChanged(Editable e) {}
        });
    input.setText(getSharedPreferences("chat-drafts", 0).getString(conversationId, ""));
    speech =
        new TextToSpeech(
            this,
            code -> {
              if (code == TextToSpeech.SUCCESS) speech.setLanguage(Locale.getDefault());
            });
    welcome();
    forwardCommand(getIntent());
  }

  void settings() {
    startActivity(
        new Intent(this, SettingsActivity.class).putExtra("conversationId", conversationId));
  }

  void forwardCommand(Intent intent) {
    String key = intent.getStringExtra("commandId");
    if (key != null) {
      intent.removeExtra("commandId");
      startActivity(new Intent(this, SettingsActivity.class).putExtra("commandId", key));
    }
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    forwardCommand(intent);
  }

  void welcome() {
    messages.removeAllViews();
    LinearLayout hero = vertical();
    hero.setPadding(dp(4), dp(70), dp(4), dp(24));
    TextView mark = label("Amadeus", 15, accent);
    hero.addView(mark);
    TextView hello = label("你好，\n今天想聊些什么？", 34, fg);
    hello.setPadding(0, dp(18), 0, dp(22));
    hero.addView(hello);
    TextView description = label("聊一个想法，探索一个项目，\n或让我帮你把事情继续推进。", 16, muted);
    description.setLineSpacing(dp(5), 1);
    hero.addView(description);
    messages.addView(hero);
    for (String suggestion : new String[] {"一起梳理一个想法", "帮我研究一个问题", "继续推进我的长期目标"}) {
      TextView chip = label(suggestion + "  ↗", 14, fg);
      chip.setPadding(dp(18), dp(14), dp(18), dp(14));
      chip.setBackground(ChatUi.rounded(surface, 18, this));
      LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
      lp.setMargins(0, dp(8), 0, 0);
      messages.addView(chip, lp);
      chip.setOnClickListener(
          v -> {
            input.setText(suggestion);
            input.requestFocus();
          });
    }
    if (!getSharedPreferences("pair", 0).contains("token")) {
      TextView connect = label("连接电脑 →", 16, accent);
      connect.setPadding(0, dp(24), 0, dp(8));
      connect.setOnClickListener(v -> settings());
      messages.addView(connect);
      status.setText("尚未连接 · 在设置中完成一次配对即可");
    }
  }

  String path(String base) {
    return conversationId.isEmpty() ? base : base + "?conversationId=" + conversationId;
  }

  void refresh() {
    if (!getSharedPreferences("pair", 0).contains("token") || !loading.compareAndSet(false, true))
      return;
    String selected = conversationId;
    work(
        () -> {
          try {
            JSONObject next =
                new AgentClient(this)
                    .call(
                        selected.isEmpty() ? "/v1/state" : "/v1/state?conversationId=" + selected,
                        null);
            runOnUiThread(
                () -> {
                  if (!conversationId.equals(selected)) return;
                  state = next;
                  JSONObject chat = next.optJSONObject("conversation");
                  if (chat != null) {
                    conversationId = chat.optString("id");
                    title.setText(
                        chat.optString("title", "Amadeus").equals("New chat")
                            ? "Amadeus"
                            : chat.optString("title"));
                    getSharedPreferences("chat-ui", 0)
                        .edit()
                        .putString("conversationId", conversationId)
                        .apply();
                  }
                  render();
                });
          } finally {
            loading.set(false);
          }
        });
  }

  void loadIndex(Runnable done) {
    work(
        () -> {
          JSONObject value = new AgentClient(this).call("/v1/conversations", null);
          runOnUiThread(
              () -> {
                index = value;
                if (done != null) done.run();
              });
        });
  }

  void render() {
    JSONArray events = state.optJSONArray("events"),
        streams = state.optJSONArray("streams"),
        runs = state.optJSONArray("runs"),
        approvals = state.optJSONArray("inputs");
    boolean running = false;
    if (runs != null && runs.length() > 0) {
      String phase = runs.optJSONObject(runs.length() - 1).optString("status");
      running = !Arrays.asList("completed", "failed", "interrupted", "cancelled").contains(phase);
    }
    status.setText(
        approvals != null && approvals.length() > 0
            ? "需要你确认 · 点击查看"
            : running ? "正在处理 · 你可以离开，任务会继续" : "已连接 · 手机与电脑同步");
    status.setOnClickListener(
        v -> {
          if (state.optJSONArray("inputs") != null && state.optJSONArray("inputs").length() > 0)
            approvals();
        });
    JSONArray profiles = index.optJSONArray("models");
    JSONObject chat = state.optJSONObject("conversation");
    if (profiles != null && chat != null)
      for (int i = 0; i < profiles.length(); i++) {
        JSONObject p = profiles.optJSONObject(i);
        if (p.optString("id").equals(chat.optString("profileId")))
          model.setText(p.optString("name") + "  ▾");
      }
    String fingerprint = String.valueOf(events) + String.valueOf(streams);
    if (fingerprint.equals(renderKey)) return;
    renderKey = fingerprint;
    boolean nearBottom =
        scroll.getChildCount() == 0
            || scroll.getChildAt(0).getHeight() - scroll.getHeight() - scroll.getScrollY()
                < dp(120);
    messages.removeAllViews();
    int count = 0;
    if (events != null)
      for (int i = 0; i < events.length(); i++) {
        JSONObject event = events.optJSONObject(i), data = event.optJSONObject("data");
        String type = event.optString("type");
        if (data != null
            && data.has("text")
            && (type.equals("user.message") || type.equals("assistant.message"))) {
          bubble(data.optString("text"), type.equals("user.message"), false);
          count++;
        }
      }
    if (streams != null)
      for (int i = 0; i < streams.length(); i++) {
        String text = streams.optJSONObject(i).optString("text");
        if (!text.isEmpty()) {
          bubble(text, false, true);
          count++;
        }
      }
    if (count == 0) welcome();
    else if (nearBottom) scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
  }

  void bubble(String text, boolean user, boolean partial) {
    LinearLayout wrap = vertical();
    wrap.setPadding(user ? dp(36) : 0, dp(10), 0, dp(14));
    TextView body = label("", 16, fg);
    body.setText(ChatUi.markdown(text));
    body.setLineSpacing(dp(5), 1);
    body.setTextIsSelectable(true);
    body.setMovementMethod(LinkMovementMethod.getInstance());
    if (user) {
      body.setBackground(ChatUi.rounded(surface, 22, this));
      body.setPadding(dp(16), dp(12), dp(16), dp(12));
      wrap.setGravity(Gravity.END);
    } else {
      TextView author = label(partial ? "Amadeus · 正在回复" : "Amadeus", 12, accent);
      author.setPadding(0, 0, 0, dp(10));
      wrap.addView(author);
    }
    wrap.addView(body);
    if (!user && !partial) {
      TextView options = label("复制    朗读    分享", 12, muted);
      options.setPadding(0, dp(12), 0, 0);
      options.setOnClickListener(
          v ->
              new AlertDialog.Builder(this)
                  .setItems(
                      new String[] {"复制回复", "朗读回复", "分享回复"},
                      (d, which) -> {
                        if (which == 0) {
                          ((android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE))
                              .setPrimaryClip(ClipData.newPlainText("Amadeus", text));
                          Toast.makeText(this, "已复制", Toast.LENGTH_SHORT).show();
                        } else if (which == 1)
                          speech.speak(
                              text.substring(
                                  0,
                                  Math.min(text.length(), TextToSpeech.getMaxSpeechInputLength())),
                              TextToSpeech.QUEUE_FLUSH,
                              null,
                              "reply");
                        else
                          startActivity(
                              Intent.createChooser(
                                  new Intent(Intent.ACTION_SEND)
                                      .setType("text/plain")
                                      .putExtra(Intent.EXTRA_TEXT, text),
                                  "分享回复"));
                      })
                  .show());
      wrap.addView(options);
    }
    messages.addView(wrap);
  }

  void select(String id) {
    conversationId = id;
    renderKey = "";
    state = new JSONObject();
    getSharedPreferences("chat-ui", 0).edit().putString("conversationId", id).apply();
    input.setText(getSharedPreferences("chat-drafts", 0).getString(id, ""));
    welcome();
    updateAttachments();
    refresh();
  }

  void send() {
    if (sending) return;
    var prefs = getSharedPreferences("outbox", 0);
    String pending = prefs.getString("pending", null);
    try {
      if (pending == null) {
        String value = input.getText().toString().trim();
        JSONArray selectedFiles =
            new JSONArray(
                getSharedPreferences("chat-attachments", 0).getString(conversationId, "[]"));
        if (value.isEmpty() && selectedFiles.length() == 0) return;
        if (value.isEmpty()) value = "请分析我上传的附件。";
        JSONArray attachmentIds = new JSONArray();
        for (int i = 0; i < selectedFiles.length(); i++)
          attachmentIds.put(selectedFiles.getJSONObject(i).getString("id"));
        pending =
            new JSONObject()
                .put("requestId", UUID.randomUUID().toString())
                .put("conversationId", conversationId.isEmpty() ? JSONObject.NULL : conversationId)
                .put("text", value)
                .put("attachmentIds", attachmentIds)
                .toString();
        if (conversationId.isEmpty()) {
          JSONObject payload = new JSONObject(pending);
          payload.remove("conversationId");
          pending = payload.toString();
        }
        if (!prefs.edit().putString("pending", pending).commit()) throw new Exception("无法保存待发送消息");
      }
      JSONObject payload = new JSONObject(pending);
      if (payload.has("conversationId")
          && !payload.isNull("conversationId")
          && !payload.getString("conversationId").equals(conversationId)) {
        status.setText("上一条消息尚待确认，请返回原会话重试，避免发到错误会话。");
        return;
      }
      String sendingConversation = payload.optString("conversationId", conversationId);
      sending = true;
      input.setEnabled(false);
      status.setText("正在发送…");
      work(
          () -> {
            try {
              JSONObject receipt = new AgentClient(this).call("/v1/message", payload);
              if (!"accepted".equals(receipt.optString("status")))
                throw new Exception("请求结果尚不确定，请检查电脑任务；不会重复执行。");
              prefs.edit().remove("pending").commit();
              var filePrefs = getSharedPreferences("chat-attachments", 0);
              JSONArray remaining = new JSONArray(filePrefs.getString(sendingConversation, "[]")),
                  sent = payload.optJSONArray("attachmentIds");
              if (sent != null)
                for (int i = remaining.length() - 1; i >= 0; i--)
                  for (int j = 0; j < sent.length(); j++)
                    if (remaining.getJSONObject(i).getString("id").equals(sent.getString(j))) {
                      remaining.remove(i);
                      break;
                    }
              filePrefs.edit().putString(sendingConversation, remaining.toString()).commit();
              getSharedPreferences("chat-drafts", 0).edit().remove(sendingConversation).apply();
              runOnUiThread(
                  () -> {
                    if (conversationId.equals(sendingConversation)) input.setText("");
                    updateAttachments();
                    status.setText("已发送");
                    refresh();
                  });
            } finally {
              sending = false;
              runOnUiThread(() -> input.setEnabled(true));
            }
          });
    } catch (Exception e) {
      status.setText(e.getMessage());
    }
  }

  void drawer() {
    loadIndex(
        () -> {
          Dialog dialog = new Dialog(this);
          LinearLayout panel = vertical();
          panel.setBackgroundColor(bg);
          panel.setPadding(dp(18), dp(36), dp(18), dp(20));
          TextView brand = label("Amadeus", 24, fg);
          brand.setTypeface(null, Typeface.BOLD);
          brand.setPadding(dp(8), 0, 0, dp(22));
          panel.addView(brand);
          drawerRow(
              panel,
              "plus",
              "新对话",
              () -> {
                dialog.dismiss();
                newChat();
              });
          drawerRow(
              panel,
              "orbit",
              "常驻助手",
              () -> {
                dialog.dismiss();
                JSONObject identity = state.optJSONObject("identity");
                if (identity != null) select(identity.optString("conversationId"));
              });
          drawerRow(
              panel,
              "memory",
              "跨对话记忆",
              () -> {
                dialog.dismiss();
                memory();
              });
          drawerRow(
              panel,
              "tools",
              "工具与设置",
              () -> {
                dialog.dismiss();
                settings();
              });
          EditText search = new EditText(this);
          search.setSingleLine(true);
          search.setTextColor(fg);
          search.setTextSize(14);
          search.setHintTextColor(muted);
          search.setHint("搜索会话");
          panel.addView(search);
          ScrollView listScroll = new ScrollView(this);
          LinearLayout list = vertical();
          listScroll.addView(list);
          panel.addView(listScroll, new LinearLayout.LayoutParams(-1, 0, 1));
          Runnable populate =
              () -> {
                list.removeAllViews();
                JSONArray chats = index.optJSONArray("conversations"),
                    projects = index.optJSONArray("projects");
                String query = search.getText().toString().toLowerCase(Locale.ROOT);
                TextView section = label("最近对话", 12, muted);
                section.setPadding(dp(8), dp(20), 0, dp(8));
                list.addView(section);
                if (chats != null)
                  for (int i = chats.length() - 1; i >= 0; i--) {
                    JSONObject c = chats.optJSONObject(i);
                    if (c.isNull("projectId")
                        && c.optString("title").toLowerCase(Locale.ROOT).contains(query))
                      drawerRow(
                          list,
                          "chat",
                          c.optString("title"),
                          () -> {
                            dialog.dismiss();
                            select(c.optString("id"));
                          });
                  }
                if (projects != null)
                  for (int i = 0; i < projects.length(); i++) {
                    JSONObject p = projects.optJSONObject(i);
                    drawerRow(
                        list,
                        "folder",
                        p.optString("name"),
                        () -> {
                          dialog.dismiss();
                          createChat(p.optString("id"));
                        });
                    if (chats != null)
                      for (int j = chats.length() - 1; j >= 0; j--) {
                        JSONObject c = chats.optJSONObject(j);
                        if (p.optString("id").equals(c.optString("projectId"))
                            && c.optString("title").toLowerCase(Locale.ROOT).contains(query))
                          drawerRow(
                              list,
                              "chat",
                              "  " + c.optString("title"),
                              () -> {
                                dialog.dismiss();
                                select(c.optString("id"));
                              });
                      }
                  }
              };
          search.addTextChangedListener(
              new TextWatcher() {
                public void beforeTextChanged(CharSequence s, int a, int c, int f) {}

                public void onTextChanged(CharSequence s, int a, int b, int c) {
                  populate.run();
                }

                public void afterTextChanged(Editable e) {}
              });
          populate.run();
          dialog.setContentView(panel);
          Window window = dialog.getWindow();
          if (window != null) {
            window.setBackgroundDrawableResource(android.R.color.transparent);
            window.setGravity(Gravity.START);
            window.setLayout((int) (getResources().getDisplayMetrics().widthPixels * .87), -1);
          }
          dialog.show();
          window.setLayout((int) (getResources().getDisplayMetrics().widthPixels * .87), -1);
        });
  }

  void drawerRow(LinearLayout parent, String type, String text, Runnable action) {
    LinearLayout row = new LinearLayout(this);
    row.setGravity(Gravity.CENTER_VERTICAL);
    row.addView(icon(type, text, action));
    TextView name = label(text, 15, fg);
    name.setSingleLine(true);
    name.setEllipsize(TextUtils.TruncateAt.END);
    row.addView(name, new LinearLayout.LayoutParams(0, dp(46), 1));
    name.setGravity(Gravity.CENTER_VERTICAL);
    row.setOnClickListener(v -> action.run());
    parent.addView(row);
  }

  void newChat() {
    loadIndex(
        () -> {
          JSONArray projects = index.optJSONArray("projects");
          String[] choices = new String[(projects == null ? 0 : projects.length()) + 1];
          choices[0] = "普通聊天";
          for (int i = 1; i < choices.length; i++)
            choices[i] = "项目 · " + projects.optJSONObject(i - 1).optString("name");
          new AlertDialog.Builder(this)
              .setTitle("新对话")
              .setItems(
                  choices,
                  (d, which) ->
                      createChat(
                          which == 0 ? null : projects.optJSONObject(which - 1).optString("id")))
              .show();
        });
  }

  void createChat(String project) {
    work(
        () -> {
          JSONObject chat =
              new AgentClient(this)
                  .call(
                      "/v1/conversations",
                      new JSONObject()
                          .put("projectId", project == null ? JSONObject.NULL : project));
          runOnUiThread(() -> select(chat.optString("id")));
        });
  }

  void models() {
    loadIndex(
        () -> {
          JSONArray values = index.optJSONArray("models");
          if (values == null) return;
          String[] names = new String[values.length()];
          for (int i = 0; i < names.length; i++)
            names[i] =
                values.optJSONObject(i).optString("name")
                    + (values.optJSONObject(i).optBoolean("vision") ? " · 可读图片" : "");
          new AlertDialog.Builder(this)
              .setTitle("选择模型")
              .setItems(
                  names,
                  (d, which) ->
                      work(
                          () -> {
                            new AgentClient(this)
                                .call(
                                    "/v1/conversations/" + conversationId + "/update",
                                    new JSONObject()
                                        .put(
                                            "profileId",
                                            values.getJSONObject(which).getString("id")));
                            refresh();
                          }))
              .show();
        });
  }

  void chatMenu() {
    new AlertDialog.Builder(this)
        .setItems(
            new String[] {"重命名会话", "置顶会话", "停止当前任务", "刷新连接", "工具与设置"},
            (d, which) -> {
              if (which == 0) {
                EditText value = new EditText(this);
                value.setText(title.getText());
                new AlertDialog.Builder(this)
                    .setTitle("会话名称")
                    .setView(value)
                    .setNegativeButton("取消", null)
                    .setPositiveButton(
                        "保存",
                        (a, b) ->
                            work(
                                () -> {
                                  new AgentClient(this)
                                      .call(
                                          "/v1/conversations/" + conversationId + "/update",
                                          new JSONObject()
                                              .put("title", value.getText().toString()));
                                  refresh();
                                }))
                    .show();
              } else if (which == 1)
                work(
                    () -> {
                      new AgentClient(this)
                          .call(
                              "/v1/conversations/" + conversationId + "/update",
                              new JSONObject().put("pinned", true));
                      runOnUiThread(() -> status.setText("已置顶"));
                    });
              else if (which == 2)
                work(
                    () -> {
                      new AgentClient(this)
                          .call("/v1/stop", new JSONObject().put("conversationId", conversationId));
                      refresh();
                    });
              else if (which == 3) refresh();
              else settings();
            })
        .show();
  }

  void attachments() {
    new AlertDialog.Builder(this)
        .setTitle("添加到对话")
        .setItems(
            new String[] {"照片", "文件 / 录音 / 文档"},
            (d, which) ->
                startActivity(
                    new Intent(this, SettingsActivity.class)
                        .putExtra("conversationId", conversationId)
                        .putExtra("pickFile", true)
                        .putExtra("photos", which == 0)))
        .show();
  }

  void dictate() {
    try {
      startActivityForResult(
          new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
              .putExtra(
                  RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
              .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
              .putExtra(RecognizerIntent.EXTRA_PROMPT, "对 Amadeus 说些什么"),
          21);
    } catch (ActivityNotFoundException e) {
      status.setText("系统语音输入不可用，可使用键盘麦克风。");
    }
  }

  @Override
  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request == 21 && result == RESULT_OK && data != null) {
      ArrayList<String> values = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
      if (values != null && !values.isEmpty())
        input.append((input.length() > 0 ? " " : "") + values.get(0));
    }
  }

  void tools() {
    new AlertDialog.Builder(this)
        .setTitle("工具与能力")
        .setItems(
            new String[] {"网页搜索", "深入研究", "图像创作（需要已配置服务）", "长期目标", "手机系统能力与录音", "跨对话记忆"},
            (d, which) -> {
              if (which < 3) {
                input.setText(
                    new String[] {
                          "请搜索最新资料，回答我的问题并注明来源：", "请深入研究以下问题，先明确范围，再对照资料给出结论：", "请使用已配置的图像工具创作："
                        }
                        [which]);
                input.requestFocus();
              } else if (which == 3)
                startActivity(new Intent(this, SettingsActivity.class).putExtra("newGoal", true));
              else if (which == 4) settings();
              else memory();
            })
        .show();
  }

  void approvals() {
    JSONArray list = state.optJSONArray("inputs");
    if (list == null || list.length() == 0) return;
    JSONObject q = list.optJSONObject(0);
    EditText answer = new EditText(this);
    answer.setHint("补充回答（可选）");
    new AlertDialog.Builder(this)
        .setTitle("需要你的确认")
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

  void memory() {
    work(
        () -> {
          JSONObject data = new AgentClient(this).call(path("/v1/memory"), null);
          runOnUiThread(
              () -> {
                JSONArray items = data.optJSONArray("memories");
                String[] names = new String[(items == null ? 0 : items.length()) + 2];
                names[0] = data.optBoolean("automatic") ? "关闭自动记忆与回忆" : "开启跨对话记忆";
                names[1] = "添加一条记忆";
                for (int i = 2; i < names.length; i++)
                  names[i] = items.optJSONObject(i - 2).optString("content");
                new AlertDialog.Builder(this)
                    .setTitle(
                        data.optString("scope").equals("user") ? "个人记忆 · 普通聊天共享" : "项目记忆 · 当前项目内共享")
                    .setItems(
                        names,
                        (dialog, which) -> {
                          if (which == 0)
                            memoryAction("policy", null, null, !data.optBoolean("automatic"), null);
                          else if (which == 1) editMemory(null);
                          else {
                            JSONObject item = items.optJSONObject(which - 2);
                            new AlertDialog.Builder(this)
                                .setTitle("管理记忆")
                                .setMessage(item.optString("content"))
                                .setNeutralButton("修改", (d, w) -> editMemory(item))
                                .setNegativeButton("关闭", null)
                                .setPositiveButton(
                                    "删除",
                                    (d, w) ->
                                        new AlertDialog.Builder(this)
                                            .setMessage("删除这条共享记忆？不会删除原聊天记录。")
                                            .setNegativeButton("取消", null)
                                            .setPositiveButton(
                                                "删除",
                                                (x, y) ->
                                                    memoryAction(
                                                        "forget",
                                                        item.optString("id"),
                                                        null,
                                                        null,
                                                        null))
                                            .show())
                                .show();
                          }
                        })
                    .setNegativeButton("关闭", null)
                    .show();
              });
        });
  }

  void editMemory(JSONObject item) {
    EditText value = new EditText(this);
    if (item != null) value.setText(item.optString("content"));
    new AlertDialog.Builder(this)
        .setTitle(item == null ? "希望助手记住什么" : "修改记忆")
        .setView(value)
        .setNegativeButton("取消", null)
        .setPositiveButton(
            "保存",
            (d, w) ->
                memoryAction(
                    item == null ? "create" : "update",
                    item == null ? null : item.optString("id"),
                    value.getText().toString(),
                    null,
                    item == null ? null : item.optInt("revision")))
        .show();
  }

  void memoryAction(String action, String id, String content, Boolean enabled, Integer revision) {
    work(
        () -> {
          new AgentClient(this)
              .call(
                  "/v1/memory",
                  new JSONObject()
                      .put("action", action)
                      .put("conversationId", conversationId)
                      .put("id", id)
                      .put("content", content)
                      .put("enabled", enabled)
                      .put("revision", revision));
          runOnUiThread(() -> status.setText("记忆设置已保存 · 与电脑同步"));
        });
  }

  final Runnable poll =
      new Runnable() {
        public void run() {
          if (visible) {
            refresh();
            handler.postDelayed(this, 1800);
          }
        }
      };

  void updateAttachments() {
    try {
      JSONArray files =
          new JSONArray(
              getSharedPreferences("chat-attachments", 0).getString(conversationId, "[]"));
      if (files.length() > 0) {
        attachment.setText("已添加 " + files.length() + " 个附件 · 点击管理");
        attachment.setVisibility(View.VISIBLE);
        attachment.setOnClickListener(
            v -> {
              String[] names = new String[files.length()];
              for (int i = 0; i < names.length; i++)
                names[i] = files.optJSONObject(i).optString("name");
              new AlertDialog.Builder(this)
                  .setTitle("点击移除附件")
                  .setItems(
                      names,
                      (d, index) -> {
                        files.remove(index);
                        getSharedPreferences("chat-attachments", 0)
                            .edit()
                            .putString(conversationId, files.toString())
                            .commit();
                        updateAttachments();
                      })
                  .setNegativeButton("关闭", null)
                  .show();
            });
      } else attachment.setVisibility(View.GONE);
    } catch (Exception e) {
      status.setText("无法读取附件列表");
    }
  }

  @Override
  protected void onResume() {
    super.onResume();
    visible = true;
    updateAttachments();
    handler.post(poll);
    if (getSharedPreferences("pair", 0).contains("token")) loadIndex(null);
    String pending = getSharedPreferences("outbox", 0).getString("pending", null);
    if (pending != null) {
      attachment.setText("有待发送内容 · 点击发送可安全重试");
      attachment.setVisibility(View.VISIBLE);
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
    if (speech != null) speech.shutdown();
    super.onDestroy();
  }
}
