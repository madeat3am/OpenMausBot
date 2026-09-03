package com.openmausbot.companion.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import com.openmausbot.companion.core.DownloadedFile
import java.io.File
import java.util.UUID

/** How a downloaded file is shown — `FilePreviewItem.Kind` in `AttachmentViews.swift`. */
enum class FilePreviewKind {
    /** Rendered in the app, the way a bot reply is. */
    MARKDOWN,
    /** Monospace, in the app. */
    TEXT,
    /** Handed to whatever app opens it — Android's Quick Look. */
    OTHER,
}

object FilePreviewRules {
    /** iOS reads 2 MB of a text file into the preview and says so. */
    const val TEXT_LIMIT_BYTES: Int = 2 * 1_024 * 1_024
    const val TRUNCATED_NOTE: String = "\n\n— Preview truncated. Share or open the file to read the rest. —"

    fun kind(contentType: String, filename: String): FilePreviewKind {
        val mime = contentType.lowercase()
        val suffix = filename.substringAfterLast('.', "").lowercase()
        if (mime == "text/markdown" || suffix == "md" || suffix == "markdown") return FilePreviewKind.MARKDOWN
        if (mime.startsWith("text/") || mime == "application/json") return FilePreviewKind.TEXT
        return FilePreviewKind.OTHER
    }

    fun text(data: ByteArray): String {
        val visible = if (data.size > TEXT_LIMIT_BYTES) data.copyOf(TEXT_LIMIT_BYTES) else data
        val decoded = visible.toString(Charsets.UTF_8)
        return if (data.size > TEXT_LIMIT_BYTES) decoded + TRUNCATED_NOTE else decoded
    }

    /** The name a bot's link points at, for the "Opening…" line. */
    fun nameForOpening(path: String): String =
        path.split('/', '\\').lastOrNull { it.isNotEmpty() }?.take(180) ?: "file"

    fun noViewer(filename: String): String = "No app on this phone can open $filename."
}

/** A downloaded file, on disk and in memory, ready to show. */
class FilePreviewItem(
    val file: File,
    val filename: String,
    val contentType: String,
    val data: ByteArray,
) {
    val kind: FilePreviewKind get() = FilePreviewRules.kind(contentType, filename)
}

/**
 * Where downloaded files live while they are on screen: one directory per
 * download under the app's cache, reachable through the FileProvider so a
 * viewer app can read exactly that file and nothing else. Only the most recent
 * is kept, and a replacement is written completely before the previous one is
 * removed, so a failed download cannot invalidate the file currently shown.
 */
class FilePreviews(private val context: Context) {
    private val root: File get() = File(context.cacheDir, ROOT)
    private var current: File? = null

    /** Called once at launch: whatever a previous process left behind goes. */
    fun removeStale() {
        root.deleteRecursively()
    }

    fun store(download: DownloadedFile): FilePreviewItem {
        val directory = File(root, UUID.randomUUID().toString()).apply { mkdirs() }
        val file = File(directory, download.filename)
        try {
            file.writeBytes(download.data)
        } catch (error: Throwable) {
            directory.deleteRecursively()
            throw error
        }
        current?.deleteRecursively()
        current = directory
        return FilePreviewItem(file, download.filename, download.contentType, download.data)
    }

    fun clear() {
        current?.deleteRecursively()
        current = null
    }

    /** Hand the file to the system. Returns the sentence to show when nothing will take it. */
    fun openWithSystem(item: FilePreviewItem): String? {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.$AUTHORITY_SUFFIX", item.file)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, item.contentType)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val chooser = Intent.createChooser(intent, item.filename).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(chooser)
            null
        } catch (_: ActivityNotFoundException) {
            FilePreviewRules.noViewer(item.filename)
        }
    }

    companion object {
        const val ROOT = "file-previews"
        const val AUTHORITY_SUFFIX = "transcripts"
    }
}

/** Markdown and text, shown in the app — `FilePreviewView`'s two in-app arms. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun FilePreviewSheet(item: FilePreviewItem, onDismiss: () -> Unit) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
                TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.CenterStart)) { Text("Done") }
                Text(
                    text = item.filename,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.align(Alignment.Center).padding(horizontal = 72.dp),
                )
            }
            val text = FilePreviewRules.text(item.data)
            SelectionContainer {
                when (item.kind) {
                    FilePreviewKind.MARKDOWN -> MarkdownText(
                        source = text,
                        modifier = Modifier
                            .fillMaxWidth()
                            .verticalScroll(rememberScrollState())
                            .padding(20.dp),
                    )
                    else -> Text(
                        text = text,
                        fontSize = 14.sp,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier
                            .fillMaxWidth()
                            .verticalScroll(rememberScrollState())
                            .horizontalScroll(rememberScrollState())
                            .padding(20.dp),
                    )
                }
            }
        }
    }
}
