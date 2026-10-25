import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';

describe('QueueModule', () => {
  it('should compile BullModule.forRootAsync with the queue config prefix', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
        BullModule.registerQueue({ name: 'queue-module-spec' }),
      ],
    }).compile();

    const queue = module.get<Queue>(getQueueToken('queue-module-spec'));
    expect(queue.opts.prefix).toBe('streamtube-test');
    await module.close();
  });
});
