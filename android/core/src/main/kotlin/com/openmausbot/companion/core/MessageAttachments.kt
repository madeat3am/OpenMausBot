package com.openmausbot.companion.core

import java.net.URI
import java.net.URLDecoder
import java.util.UUID

/**
 * One attachment waiting in the composer — the port of
 * `ios/Sources/CompanionCore/MessageAttachments.swift`.
 *
 * The bytes are app-owned: picker URIs are copied before this value is created,
 * so a later send never depends on a content provider still granting access.
 */
class PendingMessageAttachment(
    val id: String = UUID.randomUUID().toString(),
    val data: ByteArray,
    val name: String,
    val mime: String,
    val kind: Kind,
) {
    enum class Kind { IMAGE, FILE }

    val bytes: Int get() = data.size
}

class AttachmentPolicyException(message: String) : Exception(message)

/**
 * The same limits apply to the in-app composer and the Share target. Keeping
 * the policy in `:core` prevents either entry point from accepting an
 * attachment that the authenticated upload route will reject.
 */
object AttachmentPolicy {
    const val MAXIMUM_ITEMS: Int = 4
    const val MAXIMUM_TOTAL_BYTES: Int = 50 * 1_024 * 1_024
    const val MAXIMUM_IMAGE_BYTES: Int = 10 * 1_024 * 1_024
    const val MAXIMUM_FILE_BYTES: Int = 25 * 1_024 * 1_024

    val IMAGE_MIME_TYPES: Set<String> = setOf("image/png", "image/jpeg", "image/gif", "image/webp")

    val DOCUMENT_MIME_TYPES: Set<String> = setOf(
        "text/plain", "text/markdown", "text/csv", "text/tab-separated-values",
        "application/json", "application/pdf", "application/rtf", "text/rtf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.oasis.opendocument.text",
        "application/vnd.oasis.opendocument.spreadsheet",
        "application/vnd.oasis.opendocument.presentation",
    )

    const val TOO_MANY_ITEMS: String = "Attach up to 4 items at a time."
    const val TOTAL_TOO_LARGE: String = "Those attachments are larger than 50 MB together."
    const val INVALID_NAME: String = "That file doesn't have a valid filename."

    fun unsupportedType(name: String): String =
        "$name isn't a supported file. Try PDF, text, Word, Excel, or PowerPoint."

    fun itemTooLarge(name: String, limitMB: Int): String = "$name is larger than $limitMB MB."

    /** `type/subtype` only, lowercased — a `; charset=` parameter is not part of the type. */
    fun normalizedMime(value: String): String =
        value.substringBefore(';').trim().lowercase()

    fun kindForMime(value: String): PendingMessageAttachment.Kind? {
        val mime = normalizedMime(value)
        if (mime in IMAGE_MIME_TYPES) return PendingMessageAttachment.Kind.IMAGE
        if (mime in DOCUMENT_MIME_TYPES) return PendingMessageAttachment.Kind.FILE
        return null
    }

    /** Throws [AttachmentPolicyException] with the sentence the composer shows. */
    fun validate(attachments: List<PendingMessageAttachment>) {
        if (attachments.size > MAXIMUM_ITEMS) throw AttachmentPolicyException(TOO_MANY_ITEMS)
        if (attachments.sumOf { it.data.size.toLong() } > MAXIMUM_TOTAL_BYTES) {
            throw AttachmentPolicyException(TOTAL_TOO_LARGE)
        }
        for (attachment in attachments) {
            val name = attachment.name.trim()
            if (!validDisplayName(name)) throw AttachmentPolicyException(INVALID_NAME)
            val mime = normalizedMime(attachment.mime)
            when (attachment.kind) {
                PendingMessageAttachment.Kind.IMAGE -> {
                    if (mime !in IMAGE_MIME_TYPES) throw AttachmentPolicyException(unsupportedType(name))
                    if (attachment.data.size > MAXIMUM_IMAGE_BYTES) {
                        throw AttachmentPolicyException(itemTooLarge(name, 10))
                    }
                }
                PendingMessageAttachment.Kind.FILE -> {
                    if (mime !in DOCUMENT_MIME_TYPES) throw AttachmentPolicyException(unsupportedType(name))
                    if (attachment.data.size > MAXIMUM_FILE_BYTES) {
                        throw AttachmentPolicyException(itemTooLarge(name, 25))
                    }
                }
            }
        }
    }

    /** A syntactically plausible media type, so a server header cannot smuggle anything odd. */
    fun validMime(value: String): Boolean {
        val mime = normalizedMime(value)
        if (mime.isEmpty() || mime.toByteArray().size > 127 || '/' !in mime) return false
        return mime.all { it in '0'..'9' || it in 'a'..'z' || it in 'A'..'Z' || it in "!#$&+-./^_" }
    }

    private fun validDisplayName(value: String): Boolean =
        value.isNotEmpty() && value.toByteArray().size <= 255 &&
            '/' !in value && '\\' !in value && value.none(Char::isISOControl)
}

/**
 * What tapping a Markdown link in a message is allowed to do. Web links go to
 * the system. Absolute desktop paths go back through the authenticated
 * companion file route. Relative and custom-scheme links do nothing.
 */
sealed class LocalMessageLink {
    data class Web(val url: String) : LocalMessageLink()
    data class DesktopFile(val path: String) : LocalMessageLink()

    companion object {
        fun resolve(rawValue: String): LocalMessageLink? {
            val value = rawValue.trim()
            if (value.isEmpty() || value.toByteArray().size > 8_192 || value.any(Char::isISOControl)) return null
            if (isWindowsAbsolutePath(value) || isUncPath(value)) return DesktopFile(value)
            if (value.startsWith("/")) return DesktopFile(value)
            val uri = runCatching { URI(value) }.getOrNull() ?: return null
            val scheme = uri.scheme?.lowercase() ?: return null
            if (scheme == "http" || scheme == "https") {
                if (uri.host.isNullOrEmpty()) return null
                return Web(value)
            }
            if (scheme == "file") {
                if (uri.rawQuery != null || uri.rawFragment != null) return null
                var path = uri.rawPath?.let { decode(it) } ?: return null
                if (path.startsWith("/") && isWindowsAbsolutePath(path.drop(1))) path = path.drop(1)
                val host = uri.host
                if (!host.isNullOrEmpty() && host.lowercase() != "localhost") path = "//$host$path"
                if (!(path.startsWith("/") || isWindowsAbsolutePath(path) || isUncPath(path))) return null
                return DesktopFile(path)
            }
            return null
        }

        private fun decode(value: String): String =
            runCatching { URLDecoder.decode(value.replace("+", "%2B"), "UTF-8") }.getOrDefault(value)

        private fun isWindowsAbsolutePath(value: String): Boolean =
            value.length >= 3 && value[0].isLetter() && value[0].code < 128 && value[1] == ':' &&
                (value[2] == '/' || value[2] == '\\')

        private fun isUncPath(value: String): Boolean = value.startsWith("\\\\") || value.startsWith("//")
    }
}

/** Bytes returned by the authenticated file route, with the sanitised name and type to show them under. */
class DownloadedFile(
    val data: ByteArray,
    val filename: String,
    val contentType: String,
)
