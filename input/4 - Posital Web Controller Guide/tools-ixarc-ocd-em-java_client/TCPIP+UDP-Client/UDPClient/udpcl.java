/*==========================================================================*/
/*             |                                                            */
/* Filename    | UDPCL.JAVA                                                 */
/*             |                                                            */
/* Purpose     | Simple UDP client application.                             */
/*             |                                                            */
/* Remarks     | This client sends datagrams to the host and port specified */ 
/*             | on the command line. It awaits an echo-server on the       */  
/*             | remote end replying any user console input exept for       */
/*             | 'exit' which terminates the client.                        */
/*             |                                                            */
/* Copyright   | Smart Network Devices GmbH                                 */
/*             | Johannes-Geller-Str. 13                                    */
/*             | 41462 Neuss                                                */
/*             | Germany                                                    */
/*             |                                                            */
/* Created     | October 1, 1999                                            */
/*             |                                                            */
/* Last Change | January 21, 2000 by Peter Duchemin                         */
/*             |                                                            */
/*==========================================================================*/

import java.io.*;
import java.net.*;

public class udpcl
{
   public static void main(String args[])
   {
      try {
         // Check the number of arguments
         if (args.length < 2) {
            throw new IllegalArgumentException("Wrong number of arguments");
         }

         // Parse the arguments
         final String host = args[0];
         int port = Integer.parseInt(args[1]);
      
         // Set up streams for reading from and writing to the console.
         // The 'to_user' stream is final for use in the anonymous class below.
         BufferedReader    from_user = new BufferedReader(new InputStreamReader(System.in));
         final PrintWriter to_user   = new PrintWriter(new OutputStreamWriter(System.out));

         // Create an unconnected socket (kernel will choose an ephemeral port)
         final DatagramSocket dsocket = new DatagramSocket();
         to_user.println("Local UDP socket opened: will send to server " + host + " on port " + port);
         to_user.flush();

         // Create a thread that gets output from the server and displays 
         // it to the user. We use a separate thread for this so that we can
         // receive server messages asynchronously from user's console input.
         Thread t = new Thread() 
         {
            public void run() {
               try {
                  while(true) 
                  {
                     // Create buffer and a packet to receive data
                     byte[] buffer = new byte[1024];
                     DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
  
                     // Wait to receive a datagram. This method will block, and when
                     // it returns a packet has already been received in the buffer
                     dsocket.receive(packet);
                 
                     // Convert the contents to a string, and display it
                     String msg = new String(buffer, 0, packet.getLength());
                     to_user.println(msg);
                     to_user.flush(); 
                  }
               }
               catch(Exception e) { }
            } 
         };

         // Priority settings
         t.setPriority(Thread.currentThread().getPriority() + 1);

         // Now start the server-to-user thread
         t.start(); 

         String line;

         // While receiving in a separate thread, read the user's input
         // and pass it to the server in this thread.
         while((line = from_user.readLine()) != null) 
         {
            // Create a new message
            byte[] msg = line.getBytes();
            DatagramPacket packet = new DatagramPacket(msg, msg.length, InetAddress.getByName(host), port);

            // Local termination of the client by typing 'exit'
            if((line.equals("EXIT") || line.equals("exit")) && (line.length() == 4)) 
            {
               to_user.println("Closing local UDP socket on user request.");
               to_user.flush();
               break;
            }
         
            // Send user msg to the server
            dsocket.send(packet);
         }

         // Close the socket, which will also interrupt the blocking receive()
         // method in the receive thread.
         dsocket.close();
      }
 
      // If anything goes wrong, print an error message
      catch (IllegalArgumentException e) {
         System.err.println(e);
         System.err.println("Usage: java udpcl <hostname> <port>");
      }     
      catch (Exception e) {
         System.err.println(e);
      }     
   }
}