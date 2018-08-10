import prisma from '../../graphql/prismaContext';
import logger from '../../util/logger';
import writeToVideoUploadLog from '../../util/videoUploadLogger';
import { IPubSubConsumerPayload } from '../PubSubHandler';
import { PubSubResponseHandler } from '../PubSubResponseHandler';
import { makeFilePublic } from '../storageController';
import { IThumbnailFailedMessage, IThumbnailResponseMessage } from './VideoThumbnailHandler';
import VideoThumbnailPubSubController from './VideoThumbnailPubSubController';

export default class VideoThumbnailResponseHandler extends PubSubResponseHandler {
  constructor(pubSubController: VideoThumbnailPubSubController) {
    super(pubSubController);
  }
  public async responseHandler(message: IPubSubConsumerPayload) {
    const messageData = this.pubSubController.parseMessageData(message);
    if (messageData.error) {
      return this.handleError(messageData, message);
    }

    const response = messageData as IThumbnailResponseMessage;
    const id = response.videoUpload.id;

    const existsInThisContext = await prisma.exists.VideoUpload({ id });
    if (!existsInThisContext) {
      return message.nack();
    }

    message.ack();

    await Promise.all(response.storageLinkCreateInputs.map((linkCreateInput) => {
      logger.debug(`Created ${linkCreateInput.version}/${linkCreateInput.fileType} storage link on ${id}`);
      makeFilePublic(linkCreateInput.bucket, linkCreateInput.path);
      return prisma.mutation.createVideoUploadStorageLink({ data: linkCreateInput });
    }))
      .catch((e) => {
        logger.error(`Error setting storage links on ${id}`, e);
      });
  }

  protected async handleError(messageData: IThumbnailFailedMessage, message: IPubSubConsumerPayload) {
    const messageError: IThumbnailFailedMessage = messageData;
    const id = messageError.requestPayload.id;
    const exists = await prisma.exists.VideoUpload({ id });
    if (!exists) {
      logger.debug(`Thumbnail error handler nacking because ${id} does not exist in this environment`);
      return message.nack();
    }

    message.ack();

    const upload = await prisma.query.videoUpload({ where: { id } });

    writeToVideoUploadLog(upload, 'FAILED', 'THUMBNAIL', messageError.error);
    logger.error(`Received thumbnail handler error response: \n ${JSON.stringify(messageData.error)}`);
  }
}