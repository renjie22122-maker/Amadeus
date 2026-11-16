package io.amadeus.mobile;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import org.json.*;

public final class AgentClient {
  final Context context;

  AgentClient(Context c) {
    context = c.getApplicationContext();
  }

  static String endpoint(String value) throws Exception {
    URI uri = new URI(value.trim());
    if (!"https".equals(uri.getScheme())
        || uri.getHost() == null
        || uri.getUserInfo() != null
        || uri.getQuery() != null
        || uri.getFragment() != null
        || (uri.getPath() != null && !uri.getPath().isEmpty() && !uri.getPath().equals("/")))
      throw new Exception("Use an HTTPS origin, without a path or credentials.");
    return value.trim().replaceAll("/+$", "");
  }

  private javax.crypto.SecretKey key() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    if (!store.containsAlias("amadeus-pair")) {
      KeyGenerator generator =
          KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
      generator.init(
          new KeyGenParameterSpec.Builder(
                  "amadeus-pair", KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
              .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
              .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
              .build());
      generator.generateKey();
    }
    return (javax.crypto.SecretKey) store.getKey("amadeus-pair", null);
  }

  void save(String url, String token) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, key());
    context
        .getSharedPreferences("pair", 0)
        .edit()
        .putString("url", endpoint(url))
        .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
        .putString(
            "token",
            Base64.encodeToString(
                cipher.doFinal(token.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP))
        .commit();
  }

  String token() throws Exception {
    var p = context.getSharedPreferences("pair", 0);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(
        Cipher.DECRYPT_MODE,
        key(),
        new GCMParameterSpec(128, Base64.decode(p.getString("iv", ""), Base64.NO_WRAP)));
    return new String(
        cipher.doFinal(Base64.decode(p.getString("token", ""), Base64.NO_WRAP)),
        StandardCharsets.UTF_8);
  }

  JSONObject call(String path, JSONObject body) throws Exception {
    return request(
        context.getSharedPreferences("pair", 0).getString("url", ""), path, body, token());
  }

  static JSONObject request(String base, String path, JSONObject body, String token)
      throws Exception {
    HttpURLConnection connection =
        (HttpURLConnection) new URL(endpoint(base) + path).openConnection();
    connection.setInstanceFollowRedirects(false);
    connection.setConnectTimeout(15000);
    connection.setReadTimeout(20000);
    connection.setRequestProperty("Accept", "application/json");
    if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
    try {
      if (body != null) {
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        try (var out = connection.getOutputStream()) {
          out.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
      }
      int status = connection.getResponseCode();
      if (status >= 300 && status < 400)
        throw new IOException("Redirect refused. Use the final HTTPS origin.");
      InputStream input = status < 400 ? connection.getInputStream() : connection.getErrorStream();
      if (input == null) throw new IOException("HTTP " + status);
      byte[] bytes;
      try (input) {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer)) != -1) {
          if (output.size() + count > 2 * 1024 * 1024) throw new IOException("Response too large");
          output.write(buffer, 0, count);
        }
        bytes = output.toByteArray();
      }
      if (bytes.length > 2 * 1024 * 1024) throw new IOException("Response too large");
      JSONObject result = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
      if (status >= 400) throw new IOException(result.optString("error", "HTTP " + status));
      return result;
    } finally {
      connection.disconnect();
    }
  }
}
