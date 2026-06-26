/**
 * 通知状态管理
 * 替代原项目中的 showNotification 方法
 */

import { create } from 'zustand';
import type { ReactNode } from 'react';
import type { Notification, NotificationType } from '@/types';
import { generateId } from '@/utils/helpers';
import { NOTIFICATION_DURATION_MS } from '@/utils/constants';

interface ShowNotificationOptions {
  dedupeKey?: string;
  dedupeMs?: number;
  maxVisible?: number;
}

interface ConfirmationOptions {
  title?: string;
  message: ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'primary' | 'secondary';
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
}

interface NotificationState {
  notifications: Notification[];
  confirmation: {
    isOpen: boolean;
    isLoading: boolean;
    options: ConfirmationOptions | null;
  };
  showNotification: (
    message: string,
    type?: NotificationType,
    duration?: number,
    options?: ShowNotificationOptions
  ) => void;
  removeNotification: (id: string) => void;
  clearAll: () => void;
  showConfirmation: (options: ConfirmationOptions) => void;
  hideConfirmation: () => void;
  setConfirmationLoading: (loading: boolean) => void;
}

const DEFAULT_MAX_VISIBLE_NOTIFICATIONS = 4;
const DEFAULT_DEDUPE_MS = 2500;
const recentNotificationAt = new Map<string, number>();

export const useNotificationStore = create<NotificationState>((set) => ({
  notifications: [],
  confirmation: {
    isOpen: false,
    isLoading: false,
    options: null
  },

  showNotification: (
    message,
    type = 'info',
    duration = NOTIFICATION_DURATION_MS,
    options = {}
  ) => {
    const dedupeKey = options.dedupeKey ?? `${type}:${message}`;
    const dedupeMs = options.dedupeMs ?? DEFAULT_DEDUPE_MS;
    const now = Date.now();
    const previousAt = recentNotificationAt.get(dedupeKey);
    if (previousAt && now - previousAt < dedupeMs) {
      return;
    }
    recentNotificationAt.set(dedupeKey, now);

    const id = generateId();
    const notification: Notification = {
      id,
      message,
      type,
      duration
    };
    const maxVisible = options.maxVisible ?? DEFAULT_MAX_VISIBLE_NOTIFICATIONS;

    set((state) => ({
      notifications: [...state.notifications, notification].slice(-maxVisible)
    }));

    // 自动移除通知
    if (duration > 0) {
      setTimeout(() => {
        set((state) => ({
          notifications: state.notifications.filter((n) => n.id !== id)
        }));
      }, duration);
    }
  },

  removeNotification: (id) => {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id)
    }));
  },

  clearAll: () => {
    set({ notifications: [] });
  },

  showConfirmation: (options) => {
    set({
      confirmation: {
        isOpen: true,
        isLoading: false,
        options
      }
    });
  },

  hideConfirmation: () => {
    set((state) => ({
      confirmation: {
        ...state.confirmation,
        isOpen: false,
        options: null // Cleanup
      }
    }));
  },

  setConfirmationLoading: (loading) => {
    set((state) => ({
      confirmation: {
        ...state.confirmation,
        isLoading: loading
      }
    }));
  }
}));
