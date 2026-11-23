package com.spacebadger.mobile.library

import java.io.FilterInputStream
import java.io.InputStream

class CountingInputStream(input: InputStream) : FilterInputStream(input) {
  var bytesRead: Long = 0
    private set

  override fun read(): Int {
    val value = super.read()
    if (value != -1) {
      bytesRead += 1
    }
    return value
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    val count = super.read(buffer, offset, length)
    if (count > 0) {
      bytesRead += count.toLong()
    }
    return count
  }
}
