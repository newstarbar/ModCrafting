package com.modcrafting.observer.mixin;

import com.modcrafting.observer.ObservationTrace;
import net.minecraft.client.font.TextRenderer;
import net.minecraft.client.gui.DrawContext;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
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
        ObservationTrace.hudText(text, x, y, color);
    }
}
