import { Injectable } from '@nestjs/common';
import { RuntimeState } from '../../app/runtime-state.service.js';

export interface ProxyResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

@Injectable()
export class RobotControlProxy {
  constructor(private readonly runtime: RuntimeState) {}

  async status(): Promise<ProxyResponse> {
    return this.forward('/api/status');
  }

  private async forward(path: string): Promise<ProxyResponse> {
    if (!this.runtime.isReady()) {
      return this.json(503, {
        connected: false,
        error: 'BusAgent host is still starting',
      });
    }
    try {
      const baseUrl = this.controllerUrl();
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
        signal: AbortSignal.timeout(2_500),
      });
      const body = Buffer.from(await response.arrayBuffer());
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        body,
      };
    } catch (error) {
      return this.json(502, {
        connected: false,
        error: `robot controller unavailable: ${(error as Error).message}`,
      });
    }
  }

  private controllerUrl(): string {
    const configured =
      this.runtime.current.agents.get('robot.device_adapter')?.runtimeConfig.config
        .controller_url;
    return typeof configured === 'string' && configured.length > 0
      ? configured
      : 'http://127.0.0.1:7861';
  }

  private json(status: number, body: Record<string, unknown>): ProxyResponse {
    return {
      status,
      contentType: 'application/json; charset=utf-8',
      body: Buffer.from(JSON.stringify(body)),
    };
  }
}
