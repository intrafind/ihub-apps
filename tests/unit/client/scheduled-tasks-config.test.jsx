import { renderHook } from '@testing-library/react';
import { useScheduledTaskLimits } from '../../../client/src/features/tasks/hooks/useScheduledTasksConfig';
import { usePlatformConfig } from '../../../client/src/shared/contexts/PlatformConfigContext';

/**
 * The limits the task form reads from the platform config. A server that does
 * not send the memory keys (an older one, or a config that was never saved)
 * must leave memory usable, not switched off.
 */

jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: jest.fn()
}));

const limitsFor = scheduledTasks => {
  usePlatformConfig.mockReturnValue({ platformConfig: { scheduledTasks } });
  return renderHook(() => useScheduledTaskLimits()).result.current;
};

describe('useScheduledTaskLimits: memory', () => {
  it('reads the memory switch and the notes limit the server sends', () => {
    expect(limitsFor({ memoryEnabled: false, memoryMaxChars: 12000 })).toEqual(
      expect.objectContaining({ memoryEnabled: false, memoryMaxChars: 12000 })
    );
  });

  it('defaults to memory on with 16000 characters when the server sends neither', () => {
    expect(limitsFor({ enabled: true })).toEqual(
      expect.objectContaining({ memoryEnabled: true, memoryMaxChars: 16000 })
    );
  });

  it('defaults the same way before the platform config has loaded', () => {
    usePlatformConfig.mockReturnValue(undefined);
    const { result } = renderHook(() => useScheduledTaskLimits());
    expect(result.current).toEqual(
      expect.objectContaining({ memoryEnabled: true, memoryMaxChars: 16000 })
    );
  });
});
