import { LobeHub, LobeChatProps } from '@lobehub/ui/brand';
import { memo } from 'react';

import { isCustomBranding } from '@/const/version';

import CustomLogo from './Custom';
import ChatHubLogo from './ChatHub';

export const ProductLogo = memo<LobeChatProps>((props) => {
  if (isCustomBranding) {
    return <CustomLogo {...props} />;
  }

  return <ChatHubLogo {...props} />;
});
