/*==========================================================================*/
/*             |                                                            */
/* Filename    | TCPCL.JAVA                                                 */
/*             |                                                            */
/* Purpose     | Simple TCP client application.                             */
/*             |                                                            */
/* Remarks     | This client connects to the host and port specified on     */
/*             | the command line. It awaits an echo-server on the remote   */
/*             | end replying any user console input exept for 'exit'       */
/*             | which closes the connection and terminates the client.     */
/*             |                                                            */
/* Copyright   | Smart Network Devices GmbH                                 */
/*             | Johannes-Geller-Str. 13                                    */
/*             | 41462 Neuss                                                */
/*             | Germany                                                    */
/*             |                                                            */
/* Created     | January 5, 2000                                            */
/*             |                                                            */
/* Last Change | 06.05.2004 by Timm Bauten		                    */
/*             |                                                            */
/*==========================================================================*/

import java.io.*;
import java.net.*;

public class tcpcl {
	static volatile boolean close_from_server = false;
	static long timeSent = 0;
	static long timeNeeded = 0;
	static boolean exit=false;
	static boolean binaryreq=false;
	static boolean timereq=false;

	public static void main(String args[]) {
		try {
			// Check the number of arguments
			if (args.length < 2) {
				throw new IllegalArgumentException("Wrong number of arguments");
			}

			// Parse the arguments
			final String host = args[0];
			int port = Integer.parseInt(args[1]);
			
			while (!exit)
			{
				// Set up streams for reading from and writing to the console.
				// The 'to_user' stream is final for use in the anonymous class below.
				BufferedReader from_user =
					new BufferedReader(new InputStreamReader(System.in));
				final PrintWriter to_user =
					new PrintWriter(new OutputStreamWriter(System.out));
	
				// Connect to the specified host and port
				final Socket s = new Socket(host, port);
				to_user.println("Connected to server " + host);
				to_user.flush();
	
				// Set up streams for reading and writing to the server.
				// The 'from_server' is final for use in the anonymous class below.
				final BufferedReader from_server =
					new BufferedReader(new InputStreamReader(s.getInputStream()));
				PrintWriter to_server =
					new PrintWriter(new OutputStreamWriter(s.getOutputStream()));
	
				// Create a thread that gets output from the server and displays 
				// it to the user. We use a separate thread for this so that we can
				// receive server messages asynchronously from user's console input.
				Thread t = new Thread() {
					public void run() {
						try {
							while (true) {
								// Create a receive buffer
								String rxmsg;
								String timestr;
								String outputstr;
								long Pos=0;
								long Time=0;
	
								// Wait to receive data from the server. This method will block, and 
								// when it returns a packet has already been received in the buffer
								// or the connection has been terminated by the peer.
								
								// this will lead to a wrong value, if encoder sends in binary mode and
								// binary contains \n or \a !!!
								// but client is only to do a quick test
								rxmsg = from_server.readLine();
								
								if (rxmsg != null) {
									if (timereq){
										timeNeeded =
											System.currentTimeMillis() - timeSent;
										timestr = "Time_needed: " + timeNeeded;
										to_user.println(timestr);
									}
									
									// try here for 2 reasons:
									// 1: if encoder sends no time, this way java client will not care and go on
									// 2: if binary code for e.g. char 2 is \A, there will be no char(3)
									// would rise an error afterwards.
									try{
										Pos=	0x1000000 *	rxmsg.charAt(0) +
												0x10000	  *	rxmsg.charAt(1) +
												0x100 	  *	rxmsg.charAt(2) +
															rxmsg.charAt(3);

										Time=	0x1000000 *	rxmsg.charAt(4) +
												0x10000	  *	rxmsg.charAt(5) +
												0x100 	  *	rxmsg.charAt(6) +
															rxmsg.charAt(7);
									} catch (Exception e){}
									
									if (binaryreq){	// assume that Encoder sends binary output
										outputstr=	"Received: \""+rxmsg+"\" "+
													"; translation: Pos: " + Pos +
													"; Time: " + Time;
										to_user.println(outputstr);
									}
									else{			// assume that Encoder sends ascii output
										to_user.println(rxmsg);
									}
									to_user.flush();
								} else {
									// Termination by the remote server
									to_user.println(
										"Server " + host + " has disconnected.");
									to_user.println(
										"Type 'exit' to terminate local client.");
									to_user.flush();
									s.close();
									close_from_server = true;
									break;
								}
							}
						} catch (Exception e) {
							to_user.println(e);
							}
					}
				};
	
				// Priority settings
				t.setPriority(Thread.currentThread().getPriority() + 1);
	
				// Now start the server-to-user thread
				t.start();
	
				String line;
	
				// While receiving in a separate thread, read the user's input
				// and pass it to the server in this thread.
				while ((line = from_user.readLine()) != null) {
					// Local termination of the client by typing 'exit'
					if ((line.equals("TIME") || line.equals("time"))
						&& (line.length() == 4)) {
							to_user.println("Time mode activated: showing response time");
							to_user.flush();
							timereq=true;
						}
					else if ((line.equals("NOTIME") || line.equals("notime"))
						&& (line.length() == 6)) {
							to_user.println("Time mode deactivated.");
							to_user.flush();
							timereq=false;
						}
					else if ((line.equals("BINARY") || line.equals("binary"))
						&& (line.length() == 6)) {
							to_user.println("switching to binary mode");
							binaryreq=true;
							to_user.flush();
						}
					else if ((line.equals("ASCII") || line.equals("ascii"))
						&& (line.length() == 5)) {
							to_user.println("switching to ascii mode");
							binaryreq=false;
							to_user.flush();
						}
					else if ((line.equals("NEW") || line.equals("new"))
						&& (line.length() == 3)) {
							if (!close_from_server) {
								to_user.println(
									"renewing connection to server "
									+"on user request");
								to_user.flush();
								break;
							}
						}
					else if ((line.equals("EXIT") || line.equals("exit"))
						&& (line.length() == 4)) {
						exit = true;
						if (!close_from_server) {
							to_user.println(
								"Disconnecting from server "
									+ host
									+ " on user request.");
							to_user.flush();
						}
						break;
					}
					else {		// command is not for client, but for encoder
								// Send user's console input to the server
						to_server.println(line);
						to_server.flush();
						timeSent = System.currentTimeMillis();
					}
				}
	
				if (!close_from_server) {
					// Close the socket, which will also interrupt the blocking readLine()
					// method in the receiving thread.
					s.close();
				}
			}
		}

		// If anything goes wrong, print an error message
		catch (IllegalArgumentException e) {
			System.err.println(e);
			System.err.println("Usage: java tcpcl <hostname> <port>");
		} catch (Exception e) {
			System.err.println(e);
		}
	}
}