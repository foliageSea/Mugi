package dev.mugi.icons;

import android.app.ActivityManager;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.os.Looper;
import android.os.UserHandle;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.Method;
import java.util.regex.Pattern;

/** Runs as the ADB shell UID under app_process, not as an installed Android application. */
public final class Main {
    private static final int ICON_SIZE = 96;
    // The framework package "android" is the one exception to the dotted app ID rule.
    private static final Pattern PACKAGE_ID =
            Pattern.compile("(?:[A-Za-z][A-Za-z0-9_]*\\.)+[A-Za-z][A-Za-z0-9_]*|android");

    private Main() {}

    public static void main(String[] args) {
        if (args.length != 1 || args[0].length() > 255 || !PACKAGE_ID.matcher(args[0]).matches()) {
            System.err.println("app-icons: expected one Android package ID");
            System.exit(2);
            return;
        }

        try {
            byte[] png = readIcon(args[0]);
            // Do not write anything until lookup, rendering and encoding have all succeeded.
            System.out.write(png);
            System.out.flush();
            if (System.out.checkError()) {
                throw new IllegalStateException("could not write PNG");
            }
        } catch (PackageManager.NameNotFoundException e) {
            System.err.println("app-icons: package not found: " + args[0]);
            System.exit(1);
        } catch (Exception | LinkageError e) {
            System.err.println("app-icons: " + e);
            System.exit(1);
        }
    }

    private static byte[] readIcon(String packageId) throws Exception {
        PackageManager packages = foregroundContext().getPackageManager();
        ApplicationInfo app = packages.getApplicationInfo(packageId, 0);
        // loadIcon() silently returns a generic Android icon for missing/broken resources.
        // Instead, load the declared resource directly so clients can supply their own fallback.
        if (app.icon == 0) {
            throw new IllegalStateException("no icon declared for " + packageId);
        }
        Drawable icon = packages.getDrawable(packageId, app.icon, app);
        if (icon == null) {
            throw new IllegalStateException("icon unavailable for " + packageId);
        }

        Bitmap bitmap = Bitmap.createBitmap(ICON_SIZE, ICON_SIZE, Bitmap.Config.ARGB_8888);
        try {
            icon.setBounds(0, 0, ICON_SIZE, ICON_SIZE);
            icon.draw(new Canvas(bitmap));
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes)) {
                throw new IllegalStateException("PNG encoding failed");
            }
            return bytes.toByteArray();
        } finally {
            bitmap.recycle();
        }
    }

    @SuppressWarnings("deprecation") // Android supplies no framework main Looper in a shell process.
    private static Context foregroundContext() throws ReflectiveOperationException {
        // app_process has no Application or main Looper. Bootstrap the framework without
        // attaching to a target application. The kernel still identifies us as the shell UID.
        if (Looper.myLooper() == null) {
            Looper.prepareMainLooper();
        }
        Class<?> activityThread = Class.forName("android.app.ActivityThread");
        Method systemMain = activityThread.getMethod("systemMain");
        Object thread = systemMain.invoke(null);
        Method getSystemContext = activityThread.getMethod("getSystemContext");
        Context systemContext = (Context) getSystemContext.invoke(thread);

        // Match `pm list packages --user current` rather than assuming shell's own user (0).
        int currentUser = (Integer) ActivityManager.class.getMethod("getCurrentUser").invoke(null);
        if (currentUser < 0) {
            throw new IllegalStateException("could not determine the foreground Android user");
        }
        UserHandle user = UserHandle.class.getConstructor(int.class).newInstance(currentUser);
        Method createAsUser = Context.class.getMethod(
                "createPackageContextAsUser", String.class, int.class, UserHandle.class);
        // The framework package is available even in profiles with no com.android.shell package.
        return (Context) createAsUser.invoke(systemContext, "android", 0, user);
    }
}
