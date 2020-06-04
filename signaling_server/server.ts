process.title = 'wiser-server';

import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import express from 'express';
import {types as mediasoupTypes} from 'mediasoup';
import { Room } from './lib/Room';
import { Peer } from './lib/Peer';
import { createConnection } from 'typeorm';
import * as socketio from 'socket.io';
import yargs from 'yargs';
import { Logger } from './lib/Logger';
import { ClaDocPages, ClaDocs, ClaRoom} from './model/model';
import {lConfig} from './config/config';
import got from 'got';

const helmet = require('helmet');
const cors = require('cors');
const mediasoup = require("mediasoup");
const bodyParser = require('body-parser');
const compression = require('compression');
const morgan = require('morgan');
const logger = new Logger();
let ips;

yargs.usage('Usage: $0 --cert [file] --key [file] --eth [ethname] --publicIp [ipAdress]')
.version('wiser-server 1.0')
.demandOption(['cert', 'key'])
.option('cert', {describe : 'ssl certificate file'})
.option('key', {describe: 'ssl certificate key file'})
.option('eth', {describe: 'local network interface, default "eth0"'})
.option('publicIp', {describe: 'public ip address, default get from network'});


const certfile = yargs.argv.cert as string;
const keyfile = yargs.argv.key as string;
const localEth = yargs.argv.eth as string || 'eth0';
const publicIp = yargs.argv.publicIp;

[certfile, keyfile].forEach(file => {
	if (!fs.existsSync(file)){
		logger.error('%s do not exist!', file);
		process.exit(-1);
	}
});

const tls = {
	cert: fs.readFileSync(certfile),
	key: fs.readFileSync(keyfile),
};

const app = express();
app.use(compression());

app.use(morgan('dev'));

app.use(helmet.hsts());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());

const mediasoupWorkers = new Array<mediasoupTypes.Worker>();
let nextMediasoupWorkerIdx = 0;

const rooms = new Map<string, Room>();
app.locals.rooms = rooms;

let httpsServer: https.Server;
let io: socketio.Server;

async function run() {
	ips = await getIps();

	// Run a mediasoup Worker.
	await runMediasoupWorkers();

	// Run HTTPS server.
	await runHttpsServer();

	// Run WebSocketServer.
	await runWebSocketServer();

	// connect database
	try {
		await createConnection({
			type: 'sqlite',
			"database": "database.sqlite",
			"synchronize": true,
			entities:[
				ClaDocPages,
				ClaDocs,
				ClaRoom
			],
		});
	} catch(error) {
		logger.error(error);
	}

	// Log rooms status every 300 seconds.
	setInterval(() => {
		let all = 0;
		let closed = 0;

		rooms.forEach(room => {
			all++;
			if ( room.closed ) {
				closed++;
			}
			logger.debug(JSON.stringify(room.statusReport()));
		});

		logger.info('room total: %s, closed: %s', all, closed);
	}, 300000);

	// check for deserted rooms
	setInterval(() => {
		rooms.forEach(room => room.checkDeserted());
	}, 10000);
}

const runHttpsServer = async () => {
	app.use('/', express.static('web', {
		maxAge: '-1'
	}));

	app.get('*', (req,res,next) => {
		res.status(404).send({res: '404'});
	});

	httpsServer = https.createServer(tls, app);
	httpsServer.listen(lConfig.listeningPort, ips.localIp, () => {
		logger.info(`Listening at ${lConfig.listeningPort}...`);
	});

	const httpServer = http.createServer(app);
	httpServer.listen(lConfig.listeningRedirectPort, ips.localIp, () => {
		logger.info(`Listening at ${lConfig.listeningRedirectPort}...`);
	});
}

const runWebSocketServer = async () => {
	io = socketio.listen(httpsServer, {
		pingTimeout: 3000,
		pingInterval: 5000,
	});

	logger.info("run websocket server....");

	io.on('connection', async (socket) => {
		const { roomId, peerId } = socket.handshake.query;

		if (!roomId || !peerId) {
			logger.warn('connection request without roomId and/or peerId');
			socket.disconnect(true);
			return;
		}

		logger.info('connection request [roomId:"%s", peerId:"%s"]', roomId, peerId);

		try {
			const room = await getOrCreateRoom(roomId);
			let peer = room.getPeer(peerId);

			if (!peer) {
				peer = new Peer(peerId, socket, room);
				room.handlePeer(peer);
				logger.info('new peer, %s, %s', peerId, socket.id);
			} else {
				peer.handlePeerReconnect(socket);
				logger.info('peer reconnect, %s, %s', peerId, socket.id);
			}
		} catch(error) {
				logger.error('room creation or room joining failed [error:"%o"]', error);
				socket.disconnect(true);
				return;
		};
	});
}

const runMediasoupWorkers = async () => {
	const numWorkers = os.cpus().length;

	logger.info('mediasoup version: %s, running %d mediasoup Workers...', mediasoup.version, numWorkers);

	for (let i = 0; i < numWorkers; ++i) {
		const worker = await mediasoup.createWorker( {
				logLevel   : lConfig.worker.logLevel,
				rtcMinPort : lConfig.worker.rtcMinPort,
				rtcMaxPort : lConfig.worker.rtcMaxPort,
				dtlsCertificateFile: certfile,
				dtlsPrivateKeyFile: keyfile
		}) as mediasoupTypes.Worker;

		worker.on('died', () => {
			logger.error(
				'mediasoup Worker died, exiting  in 2 seconds... [pid:%d]', worker.pid);

			setTimeout(() => process.exit(1), 2000);
		});

		mediasoupWorkers.push(worker);
	}
}

/**
 * Get next mediasoup Worker.
 */
const getMediasoupWorker = () => {
	const worker = mediasoupWorkers[nextMediasoupWorkerIdx];

	if (++nextMediasoupWorkerIdx === mediasoupWorkers.length) {
		nextMediasoupWorkerIdx = 0;
	}

	return worker;
}

const getOrCreateRoom = async (roomId: string) => {
	let room = rooms.get(roomId);

	if (!room) {
		logger.info('creating a new Room [roomId:"%s"]', roomId);

		const mediasoupWorker = getMediasoupWorker();

		room = await Room.create(mediasoupWorker, roomId );

		rooms.set(roomId, room);
		room.on('close', () => rooms.delete(roomId));
	}

	return room;
}

const getIps = async () => {
	const localIp = getLocalIp(localEth) || '127.0.0.1';
	let announcedIp = publicIp;

	if ( !announcedIp ) {
		const url = 'https://api.ipify.org?format=json';
		try {
			const res = await got(url).json() as any;
			announcedIp = res.ip;
		} catch(e) {
			logger.error('get public ip error!', e.message);
		}
	}

	if ( !announcedIp ) {
		logger.error('Got public ip error! exit now!');
		process.exit(-1);
	}

	logger.info('localIp: %s, publicIp: %s', localIp, announcedIp);

	lConfig.webRtcTransport.listenIps = [{
		ip: localIp,
		announcedIp
	}] as any;

	return {localIp, announcedIp};
}

const getLocalIp = (eth: string) => {
	const eths= os.networkInterfaces()[eth];

	let localIp = '';
	eths && eths.forEach(e => {
		if(e.family === 'IPv4') {
			localIp = e.address;
		}
	});

	return localIp;
}

run();
