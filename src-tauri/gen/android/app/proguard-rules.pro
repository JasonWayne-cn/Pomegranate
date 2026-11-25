# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# ─── 局域网同步：mDNS 查找时的 Wi-Fi 组播锁（JNI 反射调用，R8 看不见）────────────
# services/lan_discovery.rs 的 multicast_lock 经 ClassLoader.loadClass 调 acquire / release，
# 不 keep 会被 tree-shake 成空壳，运行时 NoSuchMethodError
-keep class edu.bit.inb.MulticastHelper {
    public static <methods>;
}
