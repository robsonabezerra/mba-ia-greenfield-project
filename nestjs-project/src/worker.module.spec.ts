import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { VideoProcessor } from './video-processing/video.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should resolve VideoProcessor without registering HTTP controllers', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    const controllers = [...module.get(ModulesContainer).values()].flatMap(
      (m) => [...m.controllers.keys()],
    );
    expect(controllers).toEqual([]);
    await module.close();
  }, 30000);
});
