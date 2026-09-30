FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH=/opt/gradle/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/build-tools/35.0.0:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip wget git openjdk-17-jdk-headless && rm -rf /var/lib/apt/lists/*

ARG GRADLE_VERSION=8.10.2
RUN wget -q https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip -O /tmp/gradle.zip \
 && unzip -q /tmp/gradle.zip -d /opt \
 && ln -s /opt/gradle-$GRADLE_VERSION /opt/gradle \
 && rm /tmp/gradle.zip

RUN mkdir -p $ANDROID_HOME/cmdline-tools \
 && wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O /tmp/cmdline.zip \
 && unzip -q /tmp/cmdline.zip -d $ANDROID_HOME/cmdline-tools \
 && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
 && rm /tmp/cmdline.zip \
 && yes | sdkmanager --licenses >/dev/null || true \
 && sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=8080
EXPOSE 8080
CMD ["node","server.js"]
