'use client';

import { ReactNode, memo } from 'react';
import { Center, Flexbox } from 'react-layout-kit';

import SafeSpacing from '@/components/SafeSpacing';
import AppLayoutDesktop from '@/layout/AppLayout.desktop';
import { SettingsTabs, SidebarTabKey } from '@/store/global/initialState';

//import Header from './features/Header';
import SideBar from './features/SideBar';

export interface DesktopLayoutProps {
  activeTab: SettingsTabs;
  children: ReactNode;
}

// Dans votre composant Header, vous pouvez ajouter le titre directement :
const Header = ({ activeTab }) => {
  return (
    <div>
      <h1>DASHDASH</h1> {/* Ajout du titre ici */}
      {/* Autres éléments du Header */}
    </div>
  );
};


const DesktopLayout = memo<DesktopLayoutProps>(({ children, activeTab }) => {
  return (
    <AppLayoutDesktop sidebarKey={SidebarTabKey.Setting}>
      <SideBar activeTab={activeTab} />
      <Flexbox flex={1} height={'100%'} style={{ position: 'relative' }}>
        <Header activeTab={activeTab} />
        <Flexbox align={'center'} flex={1} padding={24} style={{ overflow: 'auto' }}>
          <SafeSpacing />
          <Center gap={16} width={'100%'}>
            <h1>DASHDASH</h1> {/* Ajout du titre ici */}
            {children}
          </Center>
        </Flexbox>
      </Flexbox>
    </AppLayoutDesktop>
  );
});


export default DesktopLayout;
