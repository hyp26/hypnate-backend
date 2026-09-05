import { v2 as cloudinary } from "cloudinary";
import streamifier from "streamifier";
import { ENV } from "../config/env";

cloudinary.config({
  cloud_name: ENV.CLOUDINARY_CLOUD_NAME,
  api_key: ENV.CLOUDINARY_API_KEY,
  api_secret: ENV.CLOUDINARY_API_SECRET,
  secure: true,
});

export function uploadBufferToCloudinary(
  buffer: Buffer,
  folder = "hypnate"
) {
  return new Promise<{
    secure_url: string;
    public_id: string;
  }>((resolve, reject) => {
    const uploadStream =
      cloudinary.uploader.upload_stream(
        { folder },
        (error, result) => {
          if (error) {
            return reject(error);
          }

          if (
            !result?.secure_url ||
            !result.public_id
          ) {
            return reject(
              new Error(
                "Cloudinary upload returned no result"
              )
            );
          }

          return resolve({
            secure_url: result.secure_url,
            public_id: result.public_id,
          });
        }
      );

    streamifier
      .createReadStream(buffer)
      .pipe(uploadStream);
  });
}