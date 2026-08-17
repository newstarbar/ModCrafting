package com.modcrafting.observer.mixin;

import com.modcrafting.observer.ObservationTrace;
import net.minecraft.client.font.TextRenderer;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.text.OrderedText;
import net.minecraft.text.StringVisitable;
import net.minecraft.text.Text;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Records generic String draw calls. It does not inspect the caller or feature under test. */
@Mixin(DrawContext.class)
public class DrawContextMixin {
    @Inject(
            method = "drawText(Lnet/minecraft/client/font/TextRenderer;Ljava/lang/String;IIIZ)I",
            at = @At("HEAD"),
            require = 0
    )
    private void modcrafting$recordHudText(TextRenderer renderer, String text, int x, int y, int color, boolean shadow, CallbackInfoReturnable<Integer> cir) {
        ObservationTrace.hudText(renderer, text, x, y, color, shadow);
    }

    @Inject(method = "drawText(Lnet/minecraft/client/font/TextRenderer;Lnet/minecraft/text/Text;IIIZ)I", at = @At("HEAD"), require = 0)
    private void modcrafting$recordHudText(TextRenderer renderer, Text text, int x, int y, int color, boolean shadow, CallbackInfoReturnable<Integer> cir) {
        ObservationTrace.hudText(renderer, text == null ? null : text.getString(), x, y, color, shadow);
    }

    @Inject(method = "drawText(Lnet/minecraft/client/font/TextRenderer;Lnet/minecraft/text/OrderedText;IIIZ)I", at = @At("HEAD"), require = 0)
    private void modcrafting$recordHudText(TextRenderer renderer, OrderedText text, int x, int y, int color, boolean shadow, CallbackInfoReturnable<Integer> cir) {
        StringBuilder visible = new StringBuilder();
        if (text != null) text.accept((index, style, codePoint) -> { visible.appendCodePoint(codePoint); return true; });
        ObservationTrace.hudText(renderer, visible.toString(), x, y, color, shadow);
    }

    @Inject(method = "drawTextWithShadow(Lnet/minecraft/client/font/TextRenderer;Lnet/minecraft/text/Text;III)I", at = @At("HEAD"), require = 0)
    private void modcrafting$recordHudTextShadow(TextRenderer renderer, Text text, int x, int y, int color, CallbackInfoReturnable<Integer> cir) {
        ObservationTrace.hudText(renderer, text == null ? null : text.getString(), x, y, color, true);
    }

    @Inject(method = "drawTextWithShadow(Lnet/minecraft/client/font/TextRenderer;Lnet/minecraft/text/OrderedText;III)I", at = @At("HEAD"), require = 0)
    private void modcrafting$recordHudOrderedTextShadow(TextRenderer renderer, OrderedText text, int x, int y, int color, CallbackInfoReturnable<Integer> cir) {
        StringBuilder visible = new StringBuilder();
        if (text != null) text.accept((index, style, codePoint) -> { visible.appendCodePoint(codePoint); return true; });
        ObservationTrace.hudText(renderer, visible.toString(), x, y, color, true);
    }

    @Inject(method = "drawTextWithShadow(Lnet/minecraft/client/font/TextRenderer;Ljava/lang/String;III)I", at = @At("HEAD"), require = 0)
    private void modcrafting$recordHudStringShadow(TextRenderer renderer, String text, int x, int y, int color, CallbackInfoReturnable<Integer> cir) {
        ObservationTrace.hudText(renderer, text, x, y, color, true);
    }

    @Inject(method = "drawCenteredTextWithShadow(Lnet/minecraft/client/font/TextRenderer;Ljava/lang/String;III)V", at = @At("HEAD"), require = 0)
    private void modcrafting$recordHudCenteredStringShadow(TextRenderer renderer, String text, int centerX, int y, int color, CallbackInfo ci) {
        ObservationTrace.hudText(renderer, text, centerX - (text == null ? 0 : renderer.getWidth(text) / 2), y, color, true);
    }

    @Inject(method = "drawCenteredTextWithShadow(Lnet/minecraft/client/font/TextRenderer;Lnet/minecraft/text/Text;III)V", at = @At("HEAD"), require = 0)
    private void modcrafting$recordHudCenteredTextShadow(TextRenderer renderer, Text text, int centerX, int y, int color, CallbackInfo ci) {
        String visible = text == null ? null : text.getString();
        ObservationTrace.hudText(renderer, visible, centerX - (visible == null ? 0 : renderer.getWidth(visible) / 2), y, color, true);
    }

    @Inject(method = "drawCenteredTextWithShadow(Lnet/minecraft/client/font/TextRenderer;Lnet/minecraft/text/OrderedText;III)V", at = @At("HEAD"), require = 0)
    private void modcrafting$recordHudCenteredOrderedTextShadow(TextRenderer renderer, OrderedText text, int centerX, int y, int color, CallbackInfo ci) {
        StringBuilder visible = new StringBuilder();
        if (text != null) text.accept((index, style, codePoint) -> { visible.appendCodePoint(codePoint); return true; });
        String value = visible.toString();
        ObservationTrace.hudText(renderer, value, centerX - renderer.getWidth(value) / 2, y, color, true);
    }

    @Inject(method = "drawWrappedTextWithShadow(Lnet/minecraft/client/font/TextRenderer;Lnet/minecraft/text/StringVisitable;IIII)V", at = @At("HEAD"), require = 0)
    private void modcrafting$recordHudWrappedTextShadow(TextRenderer renderer, StringVisitable text, int x, int y, int width, int color, CallbackInfo ci) {
        ObservationTrace.hudText(renderer, text == null ? null : text.getString(), x, y, color, true);
    }

    @Inject(method = "drawWrappedText(Lnet/minecraft/client/font/TextRenderer;Lnet/minecraft/text/StringVisitable;IIIIZ)V", at = @At("HEAD"), require = 0)
    private void modcrafting$recordHudWrappedText(TextRenderer renderer, StringVisitable text, int x, int y, int width, int color, boolean shadow, CallbackInfo ci) {
        ObservationTrace.hudText(renderer, text == null ? null : text.getString(), x, y, color, shadow);
    }

    @Inject(method = "drawTextWithBackground(Lnet/minecraft/client/font/TextRenderer;Lnet/minecraft/text/Text;IIII)I", at = @At("HEAD"), require = 0)
    private void modcrafting$recordHudTextBackground(TextRenderer renderer, Text text, int x, int y, int color, int backgroundColor, CallbackInfoReturnable<Integer> cir) {
        ObservationTrace.hudText(renderer, text == null ? null : text.getString(), x, y, color, false);
    }

}
