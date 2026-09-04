import 'reflect-metadata';
import { loadEnv } from './config/load-env.js';
import { Logger } from './common/logger.js';
import { NestLogAdapter } from './common/nest-log.adapter.js';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { Server } from 'node:http';
import { AppModule } from './app.module.js';
import { HostConfig } from './config/host-config.js';
import { BusAgentError } from './common/errors.js';
import { EventIngressService } from './bus/event-ingress.service.js';
import { RegistrationService } from './registry/registration.service.js';
import { HostRuntimeService } from './app/host-runtime.service.js';
import { AudioGateway } from './modules/stt/audio-gateway.js';
import { readFrontendFile } from './app/frontend-static.js';

/** Minimal structural view of the Fastify reply used for route registration. */
interface ReplyLike {
  code(statusCode: number): ReplyLike;
  type(contentType: string): ReplyLike;
  send(payload: unknown): unknown;
}

/** Minimal structural view of the Fastify instance (avoids a direct fastify dependency). */
interface FastifyInstanceLike {
  server: Server;
  get(
    path: string,
    handler: (request: unknown, reply: ReplyLike) => void | Promise<void>,
  ): unknown;
  post(
    path: string,
    handler: (request: unknown, reply: ReplyLike) => void | Promise<void>,
  ): unknown;
}

function bodyOf(request: unknown): unknown {
  return (request as { body?: unknown }).body;
}

async function bootstrap(): Promise<void> {
  loadEnv();
  const bootLog = new Logger('BusAgentHost');
  let config: HostConfig;
  try {
    config = HostConfig.fromEnv(process.env);
  } catch (error) {
    bootLog.fatal('BusAgent host failed to load configuration', error);
    process.exit(1);
  }

  const app = await NestFactory.create(AppModule, new FastifyAdapter(), {
    logger: new NestLogAdapter(),
  });
  app.enableShutdownHooks();

  const ingress = app.get(EventIngressService);
  const registrations = app.get(RegistrationService);
  const runtime = app.get(HostRuntimeService);
  const audio = app.get(AudioGateway);
  const fastify = app.getHttpAdapter().getInstance() as unknown as FastifyInstanceLike;

  const serveFrontend = async (urlPath: string, reply: ReplyLike): Promise<void> => {
    const file = await readFrontendFile(config.frontendDir, urlPath);
    if (file === null) {
      reply.code(404).type('text/plain').send('frontend file not found');
      return;
    }
    reply.type(file.type).send(file.body);
  };
  fastify.get('/', async (_request, reply) => serveFrontend('/', reply));
  fastify.get('/stt', async (_request, reply) => serveFrontend('/stt', reply));
  fastify.get('/index.html', async (_request, reply) => serveFrontend('/index.html', reply));
  fastify.get('/styles.css', async (_request, reply) => serveFrontend('/styles.css', reply));
  fastify.get('/app.js', async (_request, reply) => serveFrontend('/app.js', reply));
  fastify.post(config.eventIngressPath, async (request, reply) => {
    if (runtime.currentState !== 'ready') {
      reply.code(503).send({ error: 'NOT_READY', message: 'host is still starting' });
      return;
    }
    const result = await ingress.handle(bodyOf(request));
    reply.code(result.status).send(result.body);
  });
  fastify.post(config.registrationPath, async (request, reply) => {
    const result = await registrations.handle(bodyOf(request));
    reply.code(result.status).send(result.body);
  });

  await app.listen(config.port, '0.0.0.0');
  audio.attach(fastify.server, '/v1/stt');
  bootLog.info(`BusAgent host listening on :${config.port} (ui=/, stt=/v1/stt)`);

  await runtime.awaitReady();
}

void bootstrap().catch((error: unknown) => {
  const message =
    error instanceof BusAgentError
      ? `${error.code}: ${error.message}`
      : (error as Error).message;
  new Logger('BusAgentHost').fatal('BusAgent host failed to start:', message);
  process.exit(1);
});
