package com.lxmusic.replica;

/* 让 WebView 的 <input type="file"> / FileReader 能读到用户选中的文件。
 * 系统文件选择器返回的是外部 content:// URI，这里把它缓存成字节，
 * 再以本应用自己的 content://com.lxmusic.replica.picked/picked/<name> 回传给 WebView。
 * 这样无需 READ_EXTERNAL_STORAGE / INTERNET 权限。
 */

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.UriMatcher;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.concurrent.ConcurrentHashMap;

public class PickedProvider extends ContentProvider {

    public static final String AUTHORITY = "com.lxmusic.replica.picked";

    private static final class Picked {
        final String name;
        final byte[] bytes;
        Picked(String n, byte[] b) { name = n; bytes = b; }
    }

    private static final ConcurrentHashMap<String, Picked> FILES =
        new ConcurrentHashMap<String, Picked>();
    private static final UriMatcher MATCHER = new UriMatcher(UriMatcher.NO_MATCH);
    static { MATCHER.addURI(AUTHORITY, "picked/*", 1); }

    /** 由 MainActivity.onActivityResult 调用；key 原样保留中文文件名 */
    public static void put(String name, byte[] bytes) { FILES.put(name, new Picked(name, bytes)); }

    @Override
    public boolean onCreate() { return true; }

    private Picked find(Uri uri) {
        if (MATCHER.match(uri) != 1) return null;
        return FILES.get(uri.getLastPathSegment());
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        Picked p = find(uri);
        String[] cols = (projection == null || projection.length == 0)
            ? new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE, "_data" }
            : projection;
        MatrixCursor c = new MatrixCursor(cols, 1);
        if (p != null) {
            Object[] row = new Object[cols.length];
            for (int i = 0; i < cols.length; i++) {
                if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = p.name;
                else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = (long) p.bytes.length;
                else row[i] = null;
            }
            c.addRow(row);
        }
        return c;
    }

    @Override
    public String getType(Uri uri) {
        Picked p = find(uri);
        if (p == null) return null;
        String n = p.name.toLowerCase();
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".js")) return "application/javascript";
        if (n.endsWith(".txt") || n.endsWith(".lrc")) return "text/plain";
        return "application/octet-stream";
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        Picked p = find(uri);
        if (p == null) throw new FileNotFoundException(uri.toString());
        try {
            File dir = getContext().getCacheDir();
            File f = new File(dir, "lx_picked_" + Math.abs(uri.toString().hashCode()));
            FileOutputStream out = new FileOutputStream(f);
            out.write(p.bytes);
            out.flush();
            out.close();
            return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
        } catch (IOException e) {
            throw new FileNotFoundException(e.getMessage());
        }
    }

    @Override public Uri insert(Uri uri, ContentValues values) { return null; }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { return 0; }
}
