import isEqual from 'fast-deep-equal';
import { produce } from 'immer';
import { gt } from 'semver';
import useSWR, { SWRResponse } from 'swr';
import type { StateCreator } from 'zustand/vanilla';

import { INBOX_SESSION_ID } from '@/const/session';
import { SESSION_CHAT_URL } from '@/const/url';
import { CURRENT_VERSION } from '@/const/version';
import { useClientDataSWR } from '@/libs/swr';
import { globalService } from '@/services/global';
import type { GlobalStore } from '@/store/global/index';
import { merge } from '@/utils/merge';
import { setNamespace } from '@/utils/storeDebug';

import type { SystemStatus } from './initialState';

const n = setNamespace('g');

/**
 * 设置操作
 */
export interface GlobalStoreAction {
  switchBackToChat: (sessionId?: string) => void;
  toggleChatSideBar: (visible?: boolean) => void;
  toggleExpandSessionGroup: (id: string, expand: boolean) => void;
  toggleMobileTopic: (visible?: boolean) => void;
  toggleSystemRole: (visible?: boolean) => void;
  updateSystemStatus: (status: Partial<SystemStatus>, action?: any) => void;
  useCheckLatestVersion: (enabledCheck?: boolean) => SWRResponse<string>;
  useInitSystemStatus: () => SWRResponse;
}

export const globalActionSlice: StateCreator<
  GlobalStore,
  [['zustand/devtools', never]],
  [],
  GlobalStoreAction
> = (set, get) => ({
  switchBackToChat: (sessionId) => {
    get().router?.push(SESSION_CHAT_URL(sessionId || INBOX_SESSION_ID, get().isMobile));
  },
  toggleChatSideBar: (newValue) => {
    const showChatSideBar =
      typeof newValue === 'boolean' ? newValue : !get().status.showChatSideBar;

    get().updateSystemStatus({ showChatSideBar }, n('toggleAgentPanel', newValue));
  },
  toggleExpandSessionGroup: (id, expand) => {
    const { status } = get();
    const nextExpandSessionGroup = produce(status.expandSessionGroupKeys, (draft: string[]) => {
      if (expand) {
        if (draft.includes(id)) return;
        draft.push(id);
      } else {
        const index = draft.indexOf(id);
        if (index !== -1) draft.splice(index, 1);
      }
    });
    get().updateSystemStatus({ expandSessionGroupKeys: nextExpandSessionGroup });
  },
  toggleMobileTopic: (newValue) => {
    const mobileShowTopic =
      typeof newValue === 'boolean' ? newValue : !get().status.mobileShowTopic;

    get().updateSystemStatus({ mobileShowTopic }, n('toggleMobileTopic', newValue));
  },
  toggleSystemRole: (newValue) => {
    const showSystemRole = typeof newValue === 'boolean' ? newValue : !get().status.mobileShowTopic;

    get().updateSystemStatus({ showSystemRole }, n('toggleMobileTopic', newValue));
  },
  updateSystemStatus: (preference, action) => {
    const nextPreference = merge(get().status, preference);

    set({ status: nextPreference }, false, action || n('updatePreference'));

    get().statusStorage.saveToLocalStorage(nextPreference);
  },

  useCheckLatestVersion: (enabledCheck = true) =>
    useSWR(enabledCheck ? 'checkLatestVersion' : null, globalService.getLatestVersion, {
      // check latest version every 30 minutes
      focusThrottleInterval: 1000 * 60 * 30,
      onSuccess: (data: string) => {
        if (gt(data, CURRENT_VERSION))
          set({ hasNewVersion: true, latestVersion: data }, false, n('checkLatestVersion'));
      },
    }),

  useInitSystemStatus: () =>
    useClientDataSWR<SystemStatus>(
      'initSystemStatus',
      () => get().statusStorage.getFromLocalStorage(),
      {
        onSuccess: (preference) => {
          const nextPreference = merge(get().status, preference);

          set({ isStatusInit: true });

          if (isEqual(get().status, nextPreference)) return;

          set({ status: nextPreference }, false, n('initSystemStatus'));
        },
      },
    ),
});
