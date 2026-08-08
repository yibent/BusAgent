import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { HostConfig } from './config/host-config.js';
import { BusAgentError } from './common/errors.js';
import { EventIngressService } from './bus/event-ingress.service.js';
import { RegistrationService } from './registry/registration.service.js';
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
  await app.init();

  // The two public endpoints honor the configurable paths (spec §4, §8).
  const ingress = app.get(EventIngressService);
  const registrations = app.get(RegistrationService);
  const fastify = app.getHttpAdapter().getInstance() as unknown as FastifyInstanceLike;

  fastify.post(config.eventIngressPath, async (request, reply) => {
    const result = await ingress.handle(bodyOf(request));
    reply.code(result.status).send(result.body);
  });
  fastify.post(config.registrationPath, async (request, reply) => {
    const result = await registrations.handle(bodyOf(request));
    reply.code(result.status).send(result.body);
  });

  await app.listen(config.port, '0.0.0.0');
  Logger.log(
    `BusAgent host listening on :${config.port} (ingress=${config.eventIngressPath}, registration=${config.registrationPath})`,
    'BusAgentHost',
  );
}

void bootstrap().catch((error: unknown) => {
  const message =
    error instanceof BusAgentError
      ? `${error.code}: ${error.message}`
      : (error as Error).message;
  console.error('BusAgent host failed to start:', message);
  process.exit(1);
});
