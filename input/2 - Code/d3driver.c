#define _WIN32_WINNT  0x501
#include <winsock2.h>
#include <ws2tcpip.h>
#include <stdio.h>
#include <errno.h>
#include <stdlib.h>
#include <unistd.h>




int main(int argc, char *argv[]) {

	int devid;
	char *in_ip, *out_ip;
	int in_port, out_port;

	if(argc < 5) {
		printf("Usage: %s <source IP> <source port> <destination IP> <destination
port> <devid>\n", argv[0]);
		return 1;
	} else {
        printf("You Entered <source IP:%s> <source port:%d> <destination IP:%s>
<destination port:%d> <devid:%d>\n", argv[1], atoi(argv[2]), argv[3],
atoi(argv[4]), atoi(argv[5]));
    }

	// Get arguments from command line
	in_ip = argv[1];
	in_port = atoi(argv[2]);
	out_ip = argv[3];
	out_port = atoi(argv[4]);
	devid = atoi(argv[5]);

    // WSADATA
    WSADATA wsaData;
    int in_winsock;

    // Initialize Winsock
    in_winsock = WSAStartup(MAKEWORD(2,2), &wsaData);
    if (in_winsock != 0) {
        printf("WSAStartup failed: %d\n", in_winsock);
        return 1;
    }

	// Create TCP SOCKET
	SOCKET in_sock;
    in_sock = socket(AF_INET, SOCK_STREAM, 0);
    if ((int)in_sock < 0) {
        printf("Error at tcp socket(): %d\n", WSAGetLastError());
        WSACleanup();
    return 1;
    }
    // Create incoming SOCKADDR TCP
    struct sockaddr_in inAddr;
    memset((char *) &inAddr, 0, sizeof(inAddr));
    inAddr.sin_family = AF_INET;
    inAddr.sin_addr.s_addr = inet_addr(in_ip);
	inAddr.sin_port = htons(in_port);

    // Connect to Encoder
    if (connect(in_sock, (struct sockaddr*)&inAddr, sizeof(inAddr)) < 0) {
        closesocket(in_sock);
        printf("Error at connect(): %d\n", WSAGetLastError());
        WSACleanup();
		return 1;
	}

	// Create UDP SOCKET
	SOCKET out_sock;
    out_sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if ((int)out_sock < 0) {
        printf("Error at udp socket(): %d\n", WSAGetLastError());
        WSACleanup();
    return 1;
    }
	// Create outgoing SOCKADDR UDP
	struct sockaddr_in outAddr;
    memset((char *) &outAddr, 0, sizeof(outAddr));
    outAddr.sin_family = AF_INET;
    outAddr.sin_addr.s_addr = inet_addr(out_ip);
	outAddr.sin_port = htons(out_port);


	// Main loop
	while(1) {
		char buf[128];
        char out[128];
		int pos, vel, n;

        // Read TCP String
		n = recv(in_sock, buf, sizeof(buf), 0);
		sscanf(buf, "%d %d", &pos, &vel);

        // Debug
		printf("Pos %d, Vel %d:\n", pos, vel);
        vel = 0; // ignore velocity

        // Convert String from POS VEL to ID:POS,VEL;
		n = snprintf(out, sizeof(out), "%d:%d,%d;\n", devid, pos, vel);

        // Send string to D3 via UDP
		n = sendto(out_sock, out, n, 0, (struct sockaddr*)&outAddr, sizeof(outAddr));

		// Debug
		printf("Sent %d to %s:\t%s", n, inet_ntoa(outAddr.sin_addr), out);
	}

	// Cleanup
	closesocket(in_sock);
	closesocket(out_sock);

	return 0;
}
