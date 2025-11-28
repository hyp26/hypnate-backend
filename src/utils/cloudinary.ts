import { v2 as cloudinary } from "cloudinary";
import streamifier from "streamifier";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

export function uploadBufferToCloudinary(buffer: Buffer, folder = "hypnate") {
  return new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder },
      (error, result) => {
        if (error) return reject(error);
        // @ts-ignore
        return resolve({ secure_url: result.secure_url, public_id: result.public_id });
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}
