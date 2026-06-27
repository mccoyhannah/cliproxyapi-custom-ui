import { useEffect } from 'react';
import { Navigate, Outlet, RouterProvider, createHashRouter } from 'react-router-dom';
import { LoginPage } from '@/pages/LoginPage';
import { NotificationContainer } from '@/components/common/NotificationContainer';
import { ConfirmationModal } from '@/components/common/ConfirmationModal';
import { CustomUiVersionSync } from '@/components/common/CustomUiVersionSync';
import { MainLayout } from '@/components/layout/MainLayout';
import {
  AUTH_FILES_FOCUS_CARDS_PATH,
  requestAuthFilesInitialQuotaRefresh,
} from '@/router/authFilesFocus';
import { ProtectedRoute } from '@/router/ProtectedRoute';
import { useLanguageStore, useThemeStore } from '@/stores';

function RootShell() {
  return (
    <>
      <CustomUiVersionSync />
      <NotificationContainer />
      <ConfirmationModal />
      <Outlet />
    </>
  );
}

function AuthFilesInitialQuotaRedirect() {
  requestAuthFilesInitialQuotaRefresh();
  return <Navigate to={AUTH_FILES_FOCUS_CARDS_PATH} replace />;
}

const router = createHashRouter([
  {
    element: <RootShell />,
    children: [
      { path: '/', element: <AuthFilesInitialQuotaRedirect /> },
      { path: '/login', element: <LoginPage /> },
      {
        path: '/*',
        element: (
          <ProtectedRoute>
            <MainLayout />
          </ProtectedRoute>
        ),
      },
    ],
  },
]);

function App() {
  const initializeTheme = useThemeStore((state) => state.initializeTheme);
  const language = useLanguageStore((state) => state.language);
  const setLanguage = useLanguageStore((state) => state.setLanguage);

  useEffect(() => {
    const cleanupTheme = initializeTheme();
    return cleanupTheme;
  }, [initializeTheme]);

  useEffect(() => {
    setLanguage(language);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 仅用于首屏同步 i18n 语言

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return <RouterProvider router={router} />;
}

export default App;
