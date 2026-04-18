package com.leonardomirabal.a303util

import android.Manifest
import android.app.Activity
import android.content.ContentValues
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream

@InvokeArg
class SavePngArgs(val fileName: String, val base64Data: String) {
  constructor() : this("", "")
}

@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE], alias = "writeExternalStorage")
  ]
)
class PngExportPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun savePng(invoke: Invoke) {
    val args = invoke.parseArgs(SavePngArgs::class.java)
    try {
      if (args.fileName.isBlank()) {
        invoke.reject("PNG export failed: missing file name.")
        return
      }
      if (args.base64Data.isBlank()) {
        invoke.reject("PNG export failed: missing PNG data.")
        return
      }

      val bytes = Base64.decode(args.base64Data, Base64.DEFAULT)
      val uriOrPath = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        saveToMediaStore(args.fileName, bytes)
      } else {
        saveToLegacyPictures(args.fileName, bytes)
      }

      val result = JSObject()
      result.put("uri", uriOrPath)
      invoke.resolve(result)
    } catch (error: Exception) {
      invoke.reject("PNG export failed: ${error.message}")
    }
  }

  private fun saveToMediaStore(fileName: String, bytes: ByteArray): String {
    val resolver = activity.contentResolver
    val collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    val values = ContentValues().apply {
      put(MediaStore.Images.Media.DISPLAY_NAME, fileName)
      put(MediaStore.Images.Media.MIME_TYPE, "image/png")
      put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/303util")
      put(MediaStore.Images.Media.IS_PENDING, 1)
    }
    val uri = resolver.insert(collection, values)
      ?: throw IllegalStateException("Android could not create a media store entry.")

    try {
      resolver.openOutputStream(uri)?.use { output ->
        output.write(bytes)
        output.flush()
      } ?: throw IllegalStateException("Android could not open the exported PNG for writing.")

      val completedValues = ContentValues().apply {
        put(MediaStore.Images.Media.IS_PENDING, 0)
      }
      resolver.update(uri, completedValues, null, null)
      return uri.toString()
    } catch (error: Exception) {
      resolver.delete(uri, null, null)
      throw error
    }
  }

  private fun saveToLegacyPictures(fileName: String, bytes: ByteArray): String {
    val picturesDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES)
    val exportDir = File(picturesDir, "303util")
    if (!exportDir.exists() && !exportDir.mkdirs()) {
      throw IllegalStateException("Android could not create the Pictures/303util folder.")
    }

    val outputFile = File(exportDir, fileName)
    FileOutputStream(outputFile).use { output ->
      output.write(bytes)
      output.flush()
    }

    MediaScannerConnection.scanFile(activity, arrayOf(outputFile.absolutePath), arrayOf("image/png"), null)
    return outputFile.absolutePath
  }
}
