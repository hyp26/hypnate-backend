import prisma from "../prisma/client";

export interface NotificationPayload {
  sellerId: number;
  type: string;
  title: string;
  body: string;
  link?: string;
  meta?: Record<string, any>;
}

export const createNotification = async (
  payload: NotificationPayload
): Promise<boolean> => {
  try {
    await prisma.notification.create({
      data: {
        sellerId: payload.sellerId,
        type: payload.type as any,
        title: payload.title,
        body: payload.body,
        link: payload.link ?? null,
        meta: payload.meta ?? undefined,
      },
    });

    return true;
  } catch (err) {
    console.error(
      "[NotificationService] Failed to create notification:",
      err
    );

    return false;
  }
};