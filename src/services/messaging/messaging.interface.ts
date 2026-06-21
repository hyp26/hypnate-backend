export interface MessagingService {
  sendMessage(
    chatId: string,
    text: string,
  ): Promise<any>;
}