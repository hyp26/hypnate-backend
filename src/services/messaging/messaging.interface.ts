export interface MessagingService {
  sendMessage(
    platform: string,
    sellerId: number,
    recipientId: string,
    text: string,
    channelId?: string
  ): Promise<any>;
}
