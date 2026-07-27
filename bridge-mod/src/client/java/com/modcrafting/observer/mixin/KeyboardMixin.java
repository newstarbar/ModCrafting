package com.modcrafting.observer.mixin;

import com.modcrafting.observer.InputGuard;
import net.minecraft.client.Keyboard;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Keyboard.class)
public class KeyboardMixin {
    @Inject(method = "onKey(JIIII)V", at = @At("HEAD"), cancellable = true)
    private void modcrafting$blockKey(long window, int key, int scancode, int action, int modifiers, CallbackInfo ci) {
        if (InputGuard.shouldBlockKey(key)) {
            ci.cancel();
        }
    }
}
