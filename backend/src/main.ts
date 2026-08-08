import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { HostConfig } from './config/host-config.js';
import { BusAgentError } from './common/errors.js';
import { EventIngressService } from './bus/event-ingress.service.js';
import { RegistrationService } from './registry/registration.service.js';
import { HostRuntimeService } from './app/host-runtime.service.js';
import { registerExampleAgents } from './examples/example-agents.js';

/** Minimal structural view of the Fastify reply used for route registration. */
interface ReplyLike {
  code(statusCode: number): ReplyLike;
  send(payload: unknown): unknown;
}

/** Minimal structural view of the Fastify instance (avoids a direct fastify dependency). */
interface FastifyInstanceLike {
  post(
    path: string,
    handler: (request: unknown, reply: ReplyLike) => void | Promise<void>,
  ): unknown;
}

function bodyOf(request: unknown): unknown {
  return (request as { body?: unknown }).body;
}

async function bootstrap(): Promise<void> {
  let config: HostConfig;
  try {
    config = HostConfig.fromEnv(process.env);
  } catch (error) {
    console.error('BusAgent host failed to load configuration', error);
    process.exit(1);
  }

  // Example in-process agents for the reference App; replace with real agents.
  registerExampleAgents();

  const app = await NestFactory.create(AppModule, new FastifyAdapter(), {
    logger: ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks();

  // The two public endpoints honor the configurable paths (spec §4, §8).
  const ingress = app.get(EventIngressService);
  const registrations = app.get(RegistrationService);
  const runtime = app.get(HostRuntimeService);
  const fastify = app.getHttpAdapter().getInstance() as unknown as FastifyInstanceLike;

  // The registration endpoint must stay open while the host waits for required
  // external agents; the event ingress is gated on readiness instead (spec §4
  // step 8-9: events are routed only once the app is `ready`).
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

  // Nest's listen() runs the bootstrap hooks before binding the port, so the
  // readiness wait must happen after the port is up or external agents could
  // never reach /internal/registrations during the wait.
  await app.listen(config.port, '0.0.0.0');
  Logger.log(
    `BusAgent host listening on :${config.port} (ingress=${config.eventIngressPath}, registration=${config.registrationPath})`,
    'BusAgentHost',
  );

  await runtime.awaitReady();
}

void bootstrap().catch((error: unknown) => {
  const message =
    error instanceof BusAgentError
      ? `${error.code}: ${error.message}`
      : (error as Error).message;
  console.error('BusAgent host failed to start:', message);
  process.exit(1);
});
