const HEARTBEAT = '{"type":"HEARTBEAT"}';
const OPEN = '{"type":"OPEN"}';
const ID_TAKEN = '{"type":"ID-TAKEN","payload":{"msg":"ID is taken"}}';


interface RoomUser {
	id: string
	name: string
	user: true
}

export class PeerServerDO implements DurableObject {
	constructor(
		private state: DurableObjectState,
		private env: Env,
	) {
		// PeerJS heartbeat
		this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT, HEARTBEAT));
	}

	get users() {
		return this.state.getWebSockets("user").map(ws => ws.deserializeAttachment()) as RoomUser[]
	}

	get names() {
		return this.users.map(({ name }) => name)
	}

	// room users broadcasting
	update(without?: string) {
		const webSockets = this.state.getWebSockets("user")
		let users = webSockets.map(webSocket => webSocket.deserializeAttachment()) as RoomUser[]
		if (without) users = users.filter(({ id }) => id !== without);
		const data = JSON.stringify(users)
		for (let webSocket of webSockets) {
			webSocket.send(data)
		}
	}

	async fetch(request: Request) {
		const url = new URL(request.url);
		const [_, a, b, c] = url.pathname.split("/")

		/**
		 * /room
		 */
		if (a === "room" && !b && !c) {
			return this.enter(url)
		}

		/**
		 * /{roomId}/peerjs
		 */
		if (a && b === "peerjs" && !c) {
			return this.peer(url)
		}

		return new Response(null, { status: 404 })
	}

	// room enter
	enter(url: URL) {
		const id = url.searchParams.get("id");
		if (!id) return new Response("id need", { status: 400 });
		const name = url.searchParams.get("name") || `guest:${id}`
		if (this.names.includes(name)) return new Response("duplicated name", { status: 400 });

		const user: RoomUser = { id, name, user: true }
		const [client, server] = Object.values(new WebSocketPair());

		this.state.acceptWebSocket(server, [name, "user"])
		server.serializeAttachment(user)
		server.send(this.state.id.toString()) // send room id

		return new Response(null, { webSocket: client, status: 101 });
	}

	// connect peer through PeerJS
	peer(url: URL) {
		const id = url.searchParams.get('id');
		const token = url.searchParams.get('token');
		if (!id || !token) return new Response(null, { status: 400 });
		const [client, server] = Object.values(new WebSocketPair());

		// check if same session exists
		const existingWss = this.state.getWebSockets(id);
		if (existingWss.length > 0 && existingWss[0].deserializeAttachment().token !== token) {
			server.accept();
			server.send(ID_TAKEN);
			server.close(1008, 'ID is taken');
			return new Response(null, { webSocket: client, status: 101 });
		} else {
			// close old session
			existingWss.forEach((ws) => ws.close(1000));
		}

		this.state.acceptWebSocket(server, [id, "peerjs"]);
		server.serializeAttachment({ id, token });
		server.send(OPEN);

		// broadcast new user entered the room
		this.update()

		return new Response(null, { webSocket: client, status: 101 });
	}

	webSocketMessage(webSocket: WebSocket, message: string): void | Promise<void> {
		// PeerJS message
		const msg = JSON.parse(message);
		const dstWs = this.state.getWebSockets(msg.dst)[0];
		msg.src = webSocket.deserializeAttachment().id;
		dstWs.send(JSON.stringify(msg));
	}

	closeOrErrorHandler(webSocket: WebSocket) {
		const data = webSocket.deserializeAttachment()
		// if room webSocket
		if ("user" in data && data.user) {
			const user = data as RoomUser
			// broadcast user exited the room
			this.update(user.id)
		}
	}

	webSocketClose(webSocket: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void> {
		this.closeOrErrorHandler(webSocket)
	}

	webSocketError(webSocket: WebSocket, error: unknown): void | Promise<void> {
		this.closeOrErrorHandler(webSocket)
	}
}

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);
		const [_, a, b, c] = url.pathname.split("/")

		/**
		 * /room
		 */
		if (a === "room" && !b && !c) {
			const room = url.searchParams.get('room');
			const ip = request.headers.get("CF-Connecting-IP")
			// if no room name, no ip
			if (!room && !ip) return new Response(null, { status: 400 });
			// if client is attempting to breach the IP room
			if ((room?.includes(".") || room?.includes(":")) && room !== ip) {
				return new Response(null, { status: 400 });
			}
			const roomId = env.PEER_SERVER.idFromName((room || ip)!)
			return env.PEER_SERVER.get(roomId).fetch(request);
		}

		/**
		 * /{roomId}/peerjs
		 */
		if (a && b === "peerjs" && !c) {
			const roomId = env.PEER_SERVER.idFromString(a);
			return env.PEER_SERVER.get(roomId).fetch(request);
		}

		return new Response(null, { status: 404 })
	},
};
