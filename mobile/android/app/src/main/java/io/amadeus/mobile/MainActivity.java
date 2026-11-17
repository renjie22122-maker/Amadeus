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
  final ExecutorService generationNetwork = Executors.newSingleThreadExecutor();
  final ExecutorService refreshNetwork = Executors.newFixedThreadPool(2);
  final LinkedHashMap<String, View> messageViews = new LinkedHashMap<>();
  final HashMap<String, String> messageContents = new HashMap<>();
  boolean responding;
  boolean localMode;
  volatile int selectionGeneration;
  AgentClient refreshClient;
  Future<?> refreshJob;
  boolean switching;
  boolean creatingChat;
  String selectionKey = "";
  long lastSelectionAt;
  LocalChat local;
  final Handler handler = new Handler(Looper.getMainLooper());
  final AtomicBoolean loading = new AtomicBoolean();
  LinearLayout root, messages, composer;
  ScrollView scroll;
  EditText input;
  TextView title, model, status, attachment, reasoningChip, searchChip;
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
            runOnUiThread(
                () -> {
                  if (!isDestroyed()) {
                    status.setVisibility(View.VISIBLE);
                    status.setText(e.getMessage());
                  }
                });
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
    if ((getResources().getConfiguration().uiMode
            & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
        == android.content.res.Configuration.UI_MODE_NIGHT_YES)
      setTheme(android.R.style.Theme_Material_NoActionBar);
    super.onCreate(saved);
    local = new LocalChat(this);
    local.toolExecutor = this::confirmLocalAction;
    localMode = getSharedPreferences("chat-ui", 0).getBoolean("localMode", false);
    boolean dark =
        (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
            == Configuration.UI_MODE_NIGHT_YES;
    bg = dark ? 0xff131314 : 0xfff9f9fc;
    fg = dark ? 0xffe9eaf0 : 0xff202124;
    muted = dark ? 0xffa6abb7 : 0xff717680;
    surface = dark ? 0xff26272a : 0xffe9edf5;
    accent = dark ? 0xffa8c7fa : 0xff3569b6;
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
    title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
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
    title.setOnLongClickListener(
        v -> {
          modeDialog();
          return true;
        });
    root.addView(header);
    status = label("", 12, muted);
    status.setPadding(dp(24), 0, dp(24), dp(6));
    status.setVisibility(View.GONE);
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
    input.setHint("问问 Amadeus");
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
    LinearLayout choices = new LinearLayout(this);
    reasoningChip = label("思考 · 自动 ▾", 13, muted);
    searchChip = label("联网搜索 · 开", 13, muted);
    for (TextView chip : new TextView[] {reasoningChip, searchChip}) {
      chip.setPadding(dp(12), dp(10), dp(12), dp(10));
      choices.addView(chip);
    }
    reasoningChip.setOnClickListener(v -> reasoningOptions());
    searchChip.setOnClickListener(
        v -> {
          if (localMode) {
            new AlertDialog.Builder(this)
                .setMessage("手机直连可通过已配置的 MCP 搜索工具获取网页资料。需自行连接提供搜索能力的服务；模型本身不会因此自动具备实时搜索。")
                .setPositiveButton("知道了", null)
                .show();
            return;
          }
          JSONObject chat = state.optJSONObject("conversation");
          if (chat == null) return;
          boolean enabled = chat.optBoolean("webSearch", true);
          new AlertDialog.Builder(this)
              .setTitle("联网搜索")
              .setMessage("允许助手按需搜索网页。关闭不会断开模型服务或电脑连接。")
              .setNegativeButton("取消", null)
              .setPositiveButton(
                  enabled ? "关闭搜索" : "开启搜索", (d, w) -> updateOption("webSearch", !enabled))
              .show();
        });
    composer.addView(choices);
    bottom.addView(composer);
    root.addView(bottom);
    conversationId =
        getSharedPreferences("chat-ui", 0).getString(localMode ? "localId" : "conversationId", "");
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

  Object confirmLocalAction(JSONObject command) throws Exception {
    CompletableFuture<Object> result = new CompletableFuture<>();
    runOnUiThread(
        () -> {
          if (isDestroyed() || !visible) {
            result.complete("Not executed: open Amadeus to confirm");
            return;
          }
          new AlertDialog.Builder(this)
              .setTitle("允许手机执行？")
              .setMessage(
                  command.optString("capability")
                      + "\n"
                      + command.optJSONObject("args")
                      + "\n由本机执行，结果将返回当前模型服务。")
              .setNegativeButton("取消", (d, w) -> result.complete("User declined; not executed"))
              .setOnCancelListener(d -> result.complete("User declined; not executed"))
              .setPositiveButton(
                  "允许一次",
                  (d, w) -> {
                    if (result.isDone() || local.cancelled) return;
                    network.execute(
                        () -> {
                          try {
                            if (local.cancelled || result.isDone()) {
                              result.complete("Cancelled; not executed");
                              return;
                            }
                            String receipt = command.optString("id");
                            getSharedPreferences("local-action-receipts", 0)
                                .edit()
                                .putString(receipt, "started; never automatically replay")
                                .commit();
                            Object value =
                                command.optString("capability").equals("mcp.request")
                                    ? local.mcp.action(command.getJSONObject("args"))
                                    : PhoneActions.run(this, command);
                            getSharedPreferences("local-action-receipts", 0)
                                .edit()
                                .putString(receipt, String.valueOf(value))
                                .apply();
                            result.complete(value);
                          } catch (Exception e) {
                            result.complete("Not completed or outcome unknown: " + e.getMessage());
                          }
                        });
                  })
              .show();
        });
    try {
      return result.get(120, TimeUnit.SECONDS);
    } catch (Exception e) {
      result.complete("Expired; not executed");
      throw e;
    }
  }

  void richView(String text, boolean html) {
    // Keep large payloads out of Binder transactions.
    if (text.length() > 150000) {
      Toast.makeText(this, "内容过长，请复制后打开", Toast.LENGTH_SHORT).show();
      return;
    }
    startActivity(
        new Intent(this, RichMessageActivity.class).putExtra("text", text).putExtra("html", html));
  }

  void codeBlocks(LinearLayout wrap, TextView plain, String text) {
    java.util.regex.Matcher m =
        java.util.regex.Pattern.compile("(?s)```([^\n]*)\n(.*?)```").matcher(text);
    if (!m.find()) return;
    plain.setVisibility(View.GONE);
    int end = 0;
    do {
      if (m.start() > end) {
        TextView p = label("", 16, fg);
        p.setText(ChatUi.markdown(text.substring(end, m.start())));
        p.setTextIsSelectable(true);
        p.setLineSpacing(dp(5), 1);
        wrap.addView(p);
      }
      String language = m.group(1).trim(), code = m.group(2);
      LinearLayout block = vertical();
      block.setPadding(dp(14), dp(8), dp(14), dp(12));
      block.setBackground(ChatUi.rounded(surface, 16, this));
      LinearLayout bar = new LinearLayout(this);
      TextView lang = label(language.isEmpty() ? "代码" : language, 12, muted);
      bar.addView(lang, new LinearLayout.LayoutParams(0, dp(40), 1));
      TextView copy = label("复制代码", 13, accent);
      copy.setPadding(dp(8), dp(8), dp(8), dp(8));
      copy.setOnClickListener(
          v -> {
            ((android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE))
                .setPrimaryClip(ClipData.newPlainText("code", code));
            Toast.makeText(this, "代码已复制", Toast.LENGTH_SHORT).show();
          });
      bar.addView(copy);
      if (language.equalsIgnoreCase("html")) {
        TextView preview = label("静态预览", 13, accent);
        preview.setPadding(dp(8), dp(8), dp(8), dp(8));
        preview.setOnClickListener(v -> richView(code, true));
        bar.addView(preview);
      }
      block.addView(bar);
      HorizontalScrollView horizontal = new HorizontalScrollView(this);
      TextView source = label(code, 14, fg);
      source.setTypeface(Typeface.MONOSPACE);
      source.setTextIsSelectable(true);
      horizontal.addView(source);
      block.addView(horizontal);
      wrap.addView(block);
      end = m.end();
    } while (m.find());
    if (end < text.length()) {
      TextView p = label("", 16, fg);
      p.setText(ChatUi.markdown(text.substring(end)));
      p.setTextIsSelectable(true);
      wrap.addView(p);
    }
  }

  void modeDialog() {
    if (sending) {
      Toast.makeText(this, "请等待当前回复完成，或先停止回复", Toast.LENGTH_SHORT).show();
      return;
    }
    new AlertDialog.Builder(this)
        .setTitle("聊天模式")
        .setSingleChoiceItems(
            new String[] {"连接电脑 · 项目与远程工具", "手机独立 · 直连模型 API"},
            localMode ? 1 : 0,
            (dialog, which) -> {
              dialog.dismiss();
              localMode = which == 1;
              getSharedPreferences("chat-ui", 0).edit().putBoolean("localMode", localMode).apply();
              index = new JSONObject();
              select(
                  getSharedPreferences("chat-ui", 0)
                      .getString(localMode ? "localId" : "conversationId", ""));
              loadIndex(null);
              if (localMode) {
                try {
                  if (local.config().optString("base").isEmpty()) localSettings();
                } catch (Exception ignored) {
                }
              }
            })
        .setNegativeButton("取消", null)
        .show();
  }

  void localSettings() {
    if (sending) {
      Toast.makeText(this, "请先停止当前回复", Toast.LENGTH_SHORT).show();
      return;
    }
    startActivity(new Intent(this, ModelSetupActivity.class));
  }

  void sendLocal() {
    String text = input.getText().toString().trim(), selected = conversationId;
    if (text.isEmpty() || selected.isEmpty()) return;
    sending = true;
    input.setEnabled(false);
    status.setVisibility(View.VISIBLE);
    status.setText("手机正在请求模型…");
    generationNetwork.execute(
        () -> {
          try {
            local.send(selected, text);
            runOnUiThread(
                () -> {
                  if (conversationId.equals(selected)) input.setText("");
                });
          } catch (Exception e) {
            runOnUiThread(
                () -> {
                  if (!isDestroyed()) {
                    status.setVisibility(View.VISIBLE);
                    status.setText(e.getMessage());
                  }
                });
          } finally {
            sending = false;
            runOnUiThread(
                () -> {
                  if (!isDestroyed()) {
                    input.setEnabled(true);
                    refresh();
                  }
                });
          }
        });
  }

  void settings() {
    startActivity(
        new Intent(this, SettingsActivity.class).putExtra("conversationId", conversationId));
  }

  void forwardCommand(Intent intent) {
    String roleId = intent.getStringExtra("localRoleId");
    if (roleId != null && !sending) {
      intent.removeExtra("localRoleId");
      localMode = true;
      getSharedPreferences("chat-ui", 0).edit().putBoolean("localMode", true).apply();
      work(
          () -> {
            JSONObject chat = local.create();
            chat.put("roleId", roleId);
            JSONObject role = local.data.role(roleId);
            chat.put("roleSnapshot", role);
            chat.put("title", role.optString("name", "角色聊天"));
            String first = role.optString("first_mes");
            if (!first.isEmpty())
              chat.getJSONArray("events")
                  .put(
                      new JSONObject()
                          .put("id", UUID.randomUUID().toString())
                          .put("type", "assistant.message")
                          .put("data", new JSONObject().put("text", first)));
            local.save(chat);
            runOnUiThread(
                () -> {
                  select(chat.optString("id"));
                  loadIndex(null);
                });
          });
    }
    String draft = intent.getStringExtra("localDraft");
    if (draft != null && !sending) {
      intent.removeExtra("localDraft");
      localMode = true;
      getSharedPreferences("chat-ui", 0).edit().putBoolean("localMode", true).apply();
      String project = intent.getStringExtra("localProject");
      work(
          () -> {
            JSONObject chat = local.create(project == null || project.isEmpty() ? null : project);
            runOnUiThread(
                () -> {
                  select(chat.optString("id"));
                  input.setText(draft);
                });
          });
    }
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
    messageViews.clear();
    messageContents.clear();
    LinearLayout hero = vertical();
    hero.setPadding(dp(4), dp(48), dp(4), dp(28));
    TextView mark = label("✦", 42, accent);
    hero.addView(mark);
    TextView hello = label("你好，\n有什么我能帮你的？", 32, fg);
    hello.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
    hello.setPadding(0, dp(18), 0, dp(22));
    hero.addView(hello);
    TextView description = label("从一个想法开始。", 16, muted);
    description.setLineSpacing(dp(5), 1);
    hero.addView(description);
    messages.addView(hero);
    for (String suggestion : new String[] {"一起梳理一个想法", "帮我研究一个问题", "继续推进我的长期目标"}) {
      TextView chip = label(suggestion + "  ↗", 14, fg);
      chip.setPadding(dp(18), dp(14), dp(18), dp(14));
      chip.setBackground(ChatUi.rounded(surface, 24, this));
      LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
      lp.setMargins(0, dp(8), 0, 0);
      messages.addView(chip, lp);
      chip.setOnClickListener(
          v -> {
            input.setText(suggestion);
            input.requestFocus();
          });
    }
    if (!localMode && !getSharedPreferences("pair", 0).contains("token")) {
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
    final int requestGeneration = selectionGeneration;
    if (localMode) {
      if (!loading.compareAndSet(false, true)) return;
      String selected = conversationId;
      refreshNetwork.execute(
          () -> {
            try {
              JSONObject next = selected.isEmpty() ? local.create() : local.read(selected);
              JSONObject snapshot = local.state(next.getString("id"));
              runOnUiThread(
                  () -> {
                    if (isDestroyed()
                        || !localMode
                        || requestGeneration != selectionGeneration
                        || !conversationId.equals(selected)) return;
                    conversationId = next.optString("id");
                    getSharedPreferences("chat-ui", 0)
                        .edit()
                        .putString("localId", conversationId)
                        .apply();
                    switching = false;
                    state = snapshot;
                    title.setText("Amadeus · 手机独立");
                    render();
                  });
            } catch (Exception e) {
              runOnUiThread(
                  () -> {
                    status.setVisibility(View.VISIBLE);
                    if (requestGeneration != selectionGeneration || !localMode) return;
                    status.setText("无法读取本机聊天 · 轻点重试");
                    status.setOnClickListener(v -> refresh());
                  });
            } finally {
              runOnUiThread(
                  () -> {
                    if (requestGeneration == selectionGeneration) loading.set(false);
                  });
            }
          });
      return;
    }
    if (!getSharedPreferences("pair", 0).contains("token") || !loading.compareAndSet(false, true))
      return;
    String selected = conversationId;
    int generation = selectionGeneration;
    final AgentClient reader;
    try {
      reader = new AgentClient(this).freeze();
      refreshClient = reader;
    } catch (Exception e) {
      loading.set(false);
      status.setText("连接信息不可用，请重新配对");
      return;
    }
    refreshJob =
        refreshNetwork.submit(
            () -> {
              if (generation != selectionGeneration) return;
              try {
                JSONObject next =
                    reader.call(
                        selected.isEmpty() ? "/v1/state" : "/v1/state?conversationId=" + selected,
                        null);
                runOnUiThread(
                    () -> {
                      if (isDestroyed()
                          || generation != selectionGeneration
                          || localMode
                          || !visible
                          || !conversationId.equals(selected)) return;
                      switching = false;
                      state = next;
                      JSONObject chat = next.optJSONObject("conversation");
                      if (chat != null) {
                        conversationId = chat.optString("id");
                        title.setText("Amadeus · 连接电脑");
                        getSharedPreferences("chat-ui", 0)
                            .edit()
                            .putString("conversationId", conversationId)
                            .apply();
                      }
                      render();
                    });
              } catch (Exception e) {
                runOnUiThread(
                    () -> {
                      if (!isDestroyed() && visible && generation == selectionGeneration) {
                        status.setVisibility(View.VISIBLE);
                        status.setText("连接未完成 · 将自动重试，轻点可立即重试");
                        status.setOnClickListener(v -> refresh());
                      }
                    });
              } finally {
                runOnUiThread(
                    () -> {
                      if (requestGeneration == selectionGeneration) loading.set(false);
                    });
              }
            });
  }

  void loadIndex(Runnable done) {
    boolean selectedMode = localMode;
    String selectedHost = getSharedPreferences("pair", 0).getString("url", "");
    final AgentClient indexClient;
    try {
      indexClient = selectedMode ? null : new AgentClient(this).freeze();
    } catch (Exception e) {
      status.setText("请先连接电脑");
      return;
    }
    work(
        () -> {
          JSONObject value =
              selectedMode ? local.index() : indexClient.call("/v1/conversations", null);
          runOnUiThread(
              () -> {
                if (isDestroyed()
                    || selectedMode != localMode
                    || (!selectedMode
                        && !selectedHost.equals(
                            getSharedPreferences("pair", 0).getString("url", "")))) return;
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
    responding = running;
    status.setVisibility(View.VISIBLE);
    status.setText(
        approvals != null && approvals.length() > 0
            ? "需要你确认 · 点击查看"
            : running ? "正在处理 · 你可以离开，任务会继续" : localMode ? "手机独立对话 · 无需电脑在线" : "已切换 · 当前对话已同步");
    status.setOnClickListener(
        v -> {
          if (state.optJSONArray("inputs") != null && state.optJSONArray("inputs").length() > 0)
            approvals();
        });
    JSONArray profiles = index.optJSONArray("models");
    JSONObject chat = state.optJSONObject("conversation");
    if (chat != null) {
      reasoningChip.setText("思考 · " + reasoningName(chat.optString("reasoning", "auto")) + " ▾");
      searchChip.setText(
          localMode ? "搜索 · 需 MCP" : "联网搜索 · " + (chat.optBoolean("webSearch", true) ? "开" : "关"));
    }
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
    LinkedHashSet<String> retained = new LinkedHashSet<>();
    if (messageViews.isEmpty()) messages.removeAllViews();
    int count = 0;
    if (events != null)
      for (int i = 0; i < events.length(); i++) {
        JSONObject event = events.optJSONObject(i), data = event.optJSONObject("data");
        String type = event.optString("type");
        if (data != null
            && data.has("text")
            && (type.equals("user.message") || type.equals("assistant.message"))) {
          reconcileMessage(
              "event:" + event.optString("id", String.valueOf(i)),
              data.optString("text"),
              type.equals("user.message"),
              false,
              retained,
              count);
          count++;
        }
      }
    if (streams != null)
      for (int i = 0; i < streams.length(); i++) {
        String text = streams.optJSONObject(i).optString("text");
        if (!text.isEmpty()) {
          reconcileMessage(
              "stream:" + streams.optJSONObject(i).optString("messageId", String.valueOf(i)),
              text,
              false,
              true,
              retained,
              count);
          count++;
        }
      }
    for (String key : new ArrayList<>(messageViews.keySet())) {
      if (!retained.contains(key)) {
        messages.removeView(messageViews.remove(key));
        messageContents.remove(key);
      }
    }
    if (count == 0) welcome();
    else if (nearBottom) scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
  }

  void reconcileMessage(
      String key, String text, boolean user, boolean partial, Set<String> retained, int position) {
    retained.add(key);
    View row = messageViews.get(key);
    if (row == null || (!partial && !text.equals(messageContents.get(key)))) {
      if (row != null) messages.removeView(row);
      row = bubble(text, user, partial);
      messageViews.put(key, row);
      messageContents.put(key, text);
      messages.addView(row, Math.min(position, messages.getChildCount()));
    } else if (!text.equals(messageContents.get(key))) {
      ((TextView) row.findViewWithTag("message-body")).setText(text);
      messageContents.put(key, text);
    }
    if (messages.indexOfChild(row) != position) {
      messages.removeView(row);
      messages.addView(row, Math.min(position, messages.getChildCount()));
    }
  }

  View bubble(String text, boolean user, boolean partial) {
    LinearLayout wrap = vertical();
    wrap.setPadding(user ? dp(36) : 0, dp(10), 0, dp(14));
    TextView body = label("", 16, fg);
    body.setTag("message-body");
    body.setText(partial ? text : ChatUi.markdown(text));
    body.setLineSpacing(dp(5), 1);
    body.setTextIsSelectable(true);
    body.setMovementMethod(LinkMovementMethod.getInstance());
    if (user) {
      body.setBackground(ChatUi.rounded(surface, 22, this));
      body.setPadding(dp(16), dp(12), dp(16), dp(12));
      wrap.setGravity(Gravity.END);
    } else {
      TextView author = label(partial ? "✦  正在回复" : "✦  Amadeus", 13, accent);
      author.setPadding(0, 0, 0, dp(10));
      wrap.addView(author);
    }
    wrap.addView(body);
    if (!user && !partial) {
      codeBlocks(wrap, body, text);
      TextView formatted = label("查看公式与完整排版 ↗", 12, accent);
      formatted.setPadding(0, dp(12), 0, dp(4));
      formatted.setOnClickListener(v -> richView(text, false));
      wrap.addView(formatted);
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
    return wrap;
  }

  void select(String id) {
    String key =
        (localMode ? "local" : getSharedPreferences("pair", 0).getString("url", "")) + ":" + id;
    if (switching && key.equals(selectionKey)) {
      Toast.makeText(this, "正在打开，请稍候", Toast.LENGTH_SHORT).show();
      return;
    }
    long now = android.os.SystemClock.elapsedRealtime();
    if (key.equals(selectionKey) && now - lastSelectionAt < 500) {
      Toast.makeText(this, "正在切换，请稍候", Toast.LENGTH_SHORT).show();
      return;
    }
    lastSelectionAt = now;
    selectionKey = key;
    selectionGeneration++;
    if (refreshJob != null) refreshJob.cancel(true);
    if (refreshClient != null) refreshClient.cancelRead();
    switching = true;
    loading.set(false);
    conversationId = id;
    renderKey = "";
    state = new JSONObject();
    getSharedPreferences("chat-ui", 0)
        .edit()
        .putString(localMode ? "localId" : "conversationId", id)
        .apply();
    input.setText(getSharedPreferences("chat-drafts", 0).getString(id, ""));
    welcome();
    status.setVisibility(View.VISIBLE);
    status.setText(localMode ? "正在打开手机对话…" : "正在从电脑加载对话…");
    int requested = selectionGeneration;
    handler.postDelayed(
        () -> {
          if (switching && requested == selectionGeneration && !isDestroyed()) {
            status.setVisibility(View.VISIBLE);
            status.setText("电脑响应较慢 · 请保持连接，无需重复点击");
          }
        },
        3500);
    updateAttachments();
    refresh();
  }

  void send() {
    if (switching) {
      Toast.makeText(this, "对话正在加载，完成后即可发送", Toast.LENGTH_SHORT).show();
      return;
    }
    if (sending) {
      Toast.makeText(this, "消息正在发送，请勿重复提交", Toast.LENGTH_SHORT).show();
      return;
    }
    if (localMode) {
      sendLocal();
      return;
    }
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

  void library(String collection) {
    startActivity(new Intent(this, LibraryActivity.class).putExtra("collection", collection));
  }

  void computers() {
    if (sending) {
      Toast.makeText(this, "请先停止当前回复", Toast.LENGTH_SHORT).show();
      return;
    }
    work(
        () -> {
          JSONArray devices = new AgentClient(this).computers();
          String[] names = new String[devices.length() + 2];
          names[0] = "手机独立聊天";
          names[1] = "配对另一台电脑";
          for (int i = 0; i < devices.length(); i++)
            names[i + 2] = devices.getJSONObject(i).getString("name");
          runOnUiThread(
              () ->
                  new AlertDialog.Builder(this)
                      .setTitle("设备与工作区")
                      .setItems(
                          names,
                          (d, which) -> {
                            if (which == 0) {
                              localMode = true;
                              getSharedPreferences("chat-ui", 0)
                                  .edit()
                                  .putBoolean("localMode", true)
                                  .apply();
                              select(getSharedPreferences("chat-ui", 0).getString("localId", ""));
                              loadIndex(null);
                            } else if (which == 1) settings();
                            else
                              work(
                                  () -> {
                                    stopService(new Intent(this, DotService.class));
                                    new AgentClient(this)
                                        .choose(devices.getJSONObject(which - 2).getString("url"));
                                    runOnUiThread(
                                        () -> {
                                          localMode = false;
                                          getSharedPreferences("chat-ui", 0)
                                              .edit()
                                              .putBoolean("localMode", false)
                                              .apply();
                                          index = new JSONObject();
                                          select("");
                                          loadIndex(null);
                                        });
                                  });
                          })
                      .show());
        });
  }

  void drawer() {
    Runnable open =
        () -> {
          Dialog dialog = new Dialog(this);
          LinearLayout panel = vertical();
          panel.setBackground(ChatUi.rounded(surface, 28, this));
          panel.setPadding(dp(18), dp(36), dp(18), dp(20));
          TextView brand = label("Amadeus", 24, fg);
          brand.setTypeface(null, Typeface.BOLD);
          brand.setPadding(dp(8), 0, 0, dp(22));
          panel.addView(brand);
          drawerRow(
              panel,
              "tavern",
              "酒馆 · 角色与世界",
              () -> {
                dialog.dismiss();
                startActivity(new Intent(this, TavernActivity.class));
              });
          drawerRow(
              panel,
              "tools",
              "手机 MCP 与记忆",
              () -> {
                dialog.dismiss();
                startActivity(
                    new Intent(this, MobileExtensionsActivity.class)
                        .putExtra("conversationId", localMode ? conversationId : ""));
              });
          drawerRow(
              panel,
              "folder",
              localMode ? "手机独立 · 切换设备" : "连接电脑 · 切换设备",
              () -> {
                dialog.dismiss();
                computers();
              });
          drawerRow(
              panel,
              "folder",
              "笔记与资料库",
              () -> {
                dialog.dismiss();
                library("notes");
              });
          drawerRow(
              panel,
              "folder",
              "手机项目",
              () -> {
                dialog.dismiss();
                library("projects");
              });
          drawerRow(
              panel,
              "tools",
              "自定义助手",
              () -> {
                dialog.dismiss();
                library("assistants");
              });
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
          panel.addView(list);
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
          loadIndex(
              () -> {
                if (dialog.isShowing()) populate.run();
              });
          ScrollView drawerScroll = new ScrollView(this);
          drawerScroll.addView(panel);
          dialog.setContentView(drawerScroll);
          Window window = dialog.getWindow();
          if (window != null) {
            window.setBackgroundDrawableResource(android.R.color.transparent);
            window.setGravity(Gravity.START);
            window.setLayout((int) (getResources().getDisplayMetrics().widthPixels * .87), -1);
          }
          dialog.show();
          window.setLayout((int) (getResources().getDisplayMetrics().widthPixels * .87), -1);
        };
    open.run();
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
    if (creatingChat) {
      Toast.makeText(this, "正在创建对话，无需重复点击", Toast.LENGTH_SHORT).show();
      return;
    }
    creatingChat = true;
    final boolean mode = localMode;
    final String host = getSharedPreferences("pair", 0).getString("url", "");
    status.setVisibility(View.VISIBLE);
    status.setText("正在创建对话…");
    final AgentClient client;
    try {
      client = mode ? null : new AgentClient(this).freeze();
    } catch (Exception e) {
      creatingChat = false;
      status.setText("连接信息不可用");
      return;
    }
    work(
        () -> {
          try {
            JSONObject chat =
                mode
                    ? local.create(project)
                    : client.call(
                        "/v1/conversations",
                        new JSONObject()
                            .put("projectId", project == null ? JSONObject.NULL : project));
            runOnUiThread(
                () -> {
                  if (mode == localMode
                      && (mode
                          || host.equals(getSharedPreferences("pair", 0).getString("url", ""))))
                    select(chat.optString("id"));
                });
          } finally {
            runOnUiThread(() -> creatingChat = false);
          }
        });
  }

  String reasoningName(String value) {
    switch (value) {
      case "none":
        return "关闭";
      case "low":
        return "轻量";
      case "medium":
        return "标准";
      case "high":
        return "深入";
      case "max":
        return "充分";
      default:
        return "自动";
    }
  }

  void updateOption(String key, Object value) {
    String selected = conversationId;
    work(
        () -> {
          if (localMode) local.update(selected, key, value);
          else
            new AgentClient(this)
                .call(
                    "/v1/conversations/" + selected + "/update", new JSONObject().put(key, value));
          runOnUiThread(this::refresh);
        });
  }

  void reasoningOptions() {
    JSONObject chat = state.optJSONObject("conversation");
    JSONArray profiles = index.optJSONArray("models");
    if (chat == null || profiles == null) return;
    ArrayList<String> values = new ArrayList<>();
    for (int i = 0; i < profiles.length(); i++) {
      JSONObject profile = profiles.optJSONObject(i);
      if (!profile.optString("id").equals(chat.optString("profileId"))) continue;
      JSONArray levels = profile.optJSONArray("efforts");
      if (levels != null) for (int j = 0; j < levels.length(); j++) values.add(levels.optString(j));
    }
    if (values.isEmpty()) values.add("auto");
    String[] labels = new String[values.size()];
    for (int i = 0; i < labels.length; i++) labels[i] = reasoningName(values.get(i));
    new AlertDialog.Builder(this)
        .setTitle("推理强度 · 当前连接支持的档位")
        .setSingleChoiceItems(
            labels,
            values.indexOf(chat.optString("reasoning", "auto")),
            (dialog, which) -> {
              dialog.dismiss();
              updateOption("reasoning", values.get(which));
            })
        .setNegativeButton("取消", null)
        .show();
  }

  void models() {
    if (localMode) {
      localSettings();
      return;
    }
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
    if (localMode) {
      new AlertDialog.Builder(this)
          .setItems(
              new String[] {"切换聊天模式", "模型连接设置", "本机记忆与 MCP", "停止回复", "手机工具与权限"},
              (d, which) -> {
                if (which == 0) modeDialog();
                else if (which == 1) localSettings();
                else if (which == 2) memory();
                else if (which == 3) local.stop();
                else settings();
              })
          .show();
      return;
    }
    new AlertDialog.Builder(this)
        .setItems(
            new String[] {"重命名会话", "置顶会话", "停止当前任务", "刷新连接", "工具与设置", "切换聊天模式"},
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
              else if (which == 5) modeDialog();
              else if (which == 3) refresh();
              else settings();
            })
        .show();
  }

  void attachments() {
    if (localMode) {
      new AlertDialog.Builder(this)
          .setMessage("独立模式当前支持文字对话。照片与文件分析请切换连接电脑模式。")
          .setPositiveButton("知道了", null)
          .show();
      return;
    }
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
    if (localMode) {
      settings();
      return;
    }
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
    if (localMode) {
      startActivity(
          new Intent(this, MobileExtensionsActivity.class)
              .putExtra("conversationId", conversationId));
      return;
    }
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
            handler.postDelayed(this, responding ? 900 : 5000);
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
    if (localMode || getSharedPreferences("pair", 0).contains("token")) loadIndex(null);
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
    handler.removeCallbacksAndMessages(null);
    if (refreshClient != null) refreshClient.cancelRead();
    refreshNetwork.shutdownNow();
    local.stop();
    generationNetwork.shutdownNow();
    network.shutdownNow();
    if (speech != null) speech.shutdown();
    super.onDestroy();
  }
}
