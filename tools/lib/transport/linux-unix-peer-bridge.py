"""Bind a Linux Unix-stream connection to its kernel-reported process owner."""
import json
import os
import selectors
import socket
import struct
import sys


def main():
    endpoint, expected_pid, expected_uid = sys.argv[1:]
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(10)
        connection.connect(endpoint)
        pid, uid, gid = struct.unpack("3i", connection.getsockopt(
            socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
        if pid != int(expected_pid) or uid != int(expected_uid):
            raise RuntimeError("kernel Unix peer identity differs")
        sys.stdout.buffer.write((json.dumps({"transportPeer": {
            "pid": pid, "uid": uid, "gid": gid}}) + "\n").encode())
        sys.stdout.buffer.flush()
        connection.settimeout(None)
        with selectors.DefaultSelector() as selector:
            selector.register(connection, selectors.EVENT_READ, "socket")
            selector.register(sys.stdin.buffer, selectors.EVENT_READ, "stdin")
            while True:
                for key, _ in selector.select():
                    if key.data == "socket":
                        data = connection.recv(65536)
                        if not data:
                            return
                        sys.stdout.buffer.write(data)
                        sys.stdout.buffer.flush()
                    else:
                        data = os.read(sys.stdin.fileno(), 65536)
                        if not data:
                            return
                        connection.sendall(data)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("LINUX_GUEST_REFUSED: " + str(error), file=sys.stderr)
        sys.exit(1)
