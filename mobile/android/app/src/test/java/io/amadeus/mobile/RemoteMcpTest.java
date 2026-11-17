package io.amadeus.mobile;
import org.junit.Test;import static org.junit.Assert.*;import java.io.*;
public class RemoteMcpTest {
 @Test public void matchesRequestAfterNotificationsAndOtherReplies()throws Exception{String events=": heartbeat\n\ndata: {\"method\":\"notifications/progress\"}\n\ndata: {\"id\":\"other\",\"result\":{}}\n\ndata: {\"id\":\"wanted\",\"result\":{\"ok\":true}}\n\n";assertTrue(RemoteMcp.readEvents(new StringReader(events),"wanted").getJSONObject("result").getBoolean("ok"));}
 @Test public void failsOnMissingResultInsteadOfReplaying() throws Exception {try{RemoteMcp.readEvents(new StringReader(": heartbeat\n\n"),"wanted");fail();}catch(IOException expected){}}
 @Test public void boundsAnUnterminatedLine() throws Exception {try{RemoteMcp.readEvents(new StringReader("x".repeat(1024*1024+1)),"wanted");fail();}catch(IOException expected){}}
 @Test public void preservesRpcErrorForCaller()throws Exception{assertEquals(-32601,RemoteMcp.readEvents(new StringReader("data: {\"id\":\"id\",\"error\":{\"code\":-32601}}\n\n"),"id").getJSONObject("error").getInt("code"));}
}
